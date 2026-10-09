# Repo contract (dotfiles/docs/agent-platform.md §Repo contract): check · deploy · verify · logs.

# All local validation, no side effects. Gating: format, lint, typecheck
# (`bun run typecheck`), tests.
check:
	bun run format:check
	bun run lint
	bun run typecheck
	bun test

# Ships the checked-out HEAD: reload + verify; on a failed verify rolls back to HEAD~1
# (detached, clean tree only). FORCE=1 / RESTART_MCP=1 pass through to `reload`.
deploy:
	@./scripts/deploy.sh

# Probes the live server: /health and /api/jobs/health (ok, no degradedRoutes). Exit 0 = healthy.
verify:
	@./scripts/verify.sh

# Bounded tail of production logs, then exits.
logs:
	@for f in err log; do echo "== ~/Library/Logs/agent-gateway.$$f (last 100) =="; tail -n 100 "$$HOME/Library/Logs/agent-gateway.$$f"; done
	@echo "== ~/Library/Logs/agent-gateway.jsonl (last 50) =="; tail -n 50 "$$HOME/Library/Logs/agent-gateway.jsonl"

dev:
	@echo "ERROR: agent-gateway runs via LaunchAgent only. Use 'make reload' to apply changes." && exit 1

start:
	@echo "ERROR: agent-gateway runs via LaunchAgent only. Use 'make reload' to apply changes." && exit 1

# Refuses while jobs are running unless FORCE=1 — a reload kills every worker session
# mid-flight (check/overview/narrative/review are re-queued once on boot; dispatch and
# excalidraw, and anything killed mid-drain regardless of tool, are left `running` for that
# same boot recovery to reconcile — server/jobs/store.ts's `execute()`).
#
# This target no longer SIGNALS the server — it POSTs to /api/shutdown (server/routes/
# shutdown.ts) and asks it to exit ITSELF. That distinction is load-bearing, not stylistic:
# launchd's ExitTimeOut is hard-capped at 60s on this host regardless of what the plist claims
# (measured 2026-09-08 — see the comment on that key in com.jkrumm.agent-gateway.plist), so a
# real `launchctl kill SIGTERM` was always going to be SIGKILLed around the 60s mark no matter
# what the old 40-minute in-process drain window said — that window was fiction the whole time
# it was wired to a signal. A SELF-initiated exit never starts launchd's ExitTimeOut clock at
# all (only a signal launchd sent itself does), so it genuinely gets the unbounded window
# (`HTTP_DRAIN_GRACE_MS`, server/lib/shutdown.ts, now Infinity) instead. KeepAlive restarts the
# process once it exits, same as any other exit. The old PID is still polled away below before
# `kickstart` runs — self-exit doesn't change that kickstart skips launchd's respawn throttle,
# so firing it while the old process is still draining would still land it on that process.
#
# FALLBACK: if the POST doesn't get a response (server hung, port dead, already crashed), this
# target falls back to `launchctl kill` — the OLD mechanism — rather than sitting there forever.
# That fallback hits the real SIGTERM/SIGINT handler in server/index.ts, which now uses the
# SHORT `SIGNAL_DRAIN_GRACE_MS` window (server/lib/shutdown.ts) precisely because THIS path is
# the one still bounded by launchd's real 60s cap — a hung server is already in a degraded state,
# and this fallback exists so it stays reloadable rather than a `make reload` that can no longer
# reach it silently hanging forever.
#
# The stdio MCP child is left alive by default — it's a thin HTTP client of the job queue, so
# stale handler code in it is harmless, and Claude Code marks a killed stdio server failed
# without respawning it. RESTART_MCP=1 make reload after a tool input/output schema change,
# because the SDK's Zod validation silently strips an unknown field until the client reconnects.
#
# Before any of that: refuses if the tracked plist differs from the one launchd actually has
# loaded, checked TWO ways — a file compare AND, separately, launchd's own live ExitTimeOut.
# `launchctl kill` (used only by the fallback above now, not the normal path) only signals the
# already-running job definition — it never re-reads a changed plist, only `launchctl bootstrap`
# (`make install-agent`) does. Neither check is theoretical: raising ExitTimeOut from 20
# (launchd's default) to 1860 in the tracked file did nothing on its own — `launchctl print
# gui/<uid>/com.jkrumm.agent-gateway` kept reporting `exit timeout = 5` until `make
# install-agent` ran (a measurement from before the follow-up measurement above established
# that even a successfully-loaded ExitTimeOut is capped at 60 regardless). The FILE compare
# alone cannot catch a stale live value: `install-agent`'s `cp` runs before its `bootstrap`, so
# if bootstrap then fails (`launchctl bootstrap` errors on an already-loaded label — the normal
# case, since this service is loaded across restarts) the installed FILE is already in sync with
# the tracked one even though launchd's LIVE definition never moved — exactly the drift this
# file-only guard existed to catch, reachable through its own blind spot. `install-agent` now
# boots the current label out before re-bootstrapping (see below) so this should no longer
# happen, but the live check stays as the check that actually matters — comparing `plutil
# -convert json` output (not raw XML) so cosmetic/comment-only plist edits don't false-positive
# on the file half.
#
# FORCE=1 is not a faster version of "wait" — waiting is the normal path; measured 2026-09-08,
# 96% of real jobs outlive a short window, so FORCE=1 reliably discards in-flight work
# (recovered on the next boot exactly like a crash — see the reconciliation note above). It asks
# for the SAME forced abort the old SIGINT did (`POST /api/shutdown?force=1`, or the fallback's
# real SIGINT if the endpoint doesn't answer), never SIGKILL: SIGKILL is not catchable, so
# neither the HTTP trigger nor the SIGTERM/SIGINT handler in server/index.ts
# (server/lib/shutdown.ts's `createShutdownController`) would ever run, and without it
# `terminateActiveSessions()` never fires — a `claude -p` worker has no process group detachment
# and no parent-death signal, so it survives as an orphan that keeps writing/committing in its
# worktree after the reload believed it was gone. A forced abort that arrives while an unforced
# drain is already in progress (e.g. `FORCE=1 make reload` run against an already-draining
# server, or the fallback's SIGINT arriving mid-HTTP-drain) ESCALATES that drain to an immediate
# abort rather than being dropped — every worker is still terminated on the way out, exactly
# once. A killed dispatch leaves a worktree behind, which the boot sweep bundles to
# ~/.local/state/agent-gateway/salvage/ before removing.
#
# The PID poll below has NO ceiling (owner decision, 2026-09-12: HTTP_DRAIN_GRACE_MS,
# server/lib/shutdown.ts, is now Infinity) — it waits as long as the old process keeps running,
# printing a progress line once a minute so a human watching knows it's still alive rather than
# hung. This is safe now that a worker actually killed anyway (idle timeout, a crash, FORCE=1)
# is resumable on the next boot (server/jobs/store.ts's `dispatchRecoveryStatusFor`) rather than
# a dead end — waiting forever here no longer risks losing work forever if it never finishes.
# The refusals above (plist drift, running jobs) live in scripts/reload-preflight.sh, which exits
# 3 on a refusal. make itself collapses that to exit 2, so scripts/deploy.sh runs the script
# directly to tell a refusal (nothing was touched) from a post-restart failure.
reload:
	@scripts/reload-preflight.sh
	@if [ -n "$(RESTART_MCP)" ]; then \
	  pkill -f "agent-gateway/server/mcp.ts" 2>/dev/null || true; \
	else \
	  echo "(MCP children left alive — RESTART_MCP=1 to restart them after a tool-schema change)"; \
	fi
	@# The self-exit below is a clean exit 0 that KeepAlive respawns — to the mini heartbeat's
	@# launchd-restart check that is a crash loop unless marked (dotfiles
	@# scripts/lib/launchd-restarts.sh: one epoch line excuses one `runs` bump).
	@d="$$HOME/.local/state/devhost/deliberate-restart"; mkdir -p "$$d" && date +%s >> "$$d/com.jkrumm.agent-gateway" || true
	@old=$$(launchctl print gui/$$(id -u)/com.jkrumm.agent-gateway 2>/dev/null | awk '/^[[:space:]]*pid = /{print $$3; exit}'); \
	shutdown_url="http://127.0.0.1:7705/api/shutdown$${FORCE:+?force=1}"; \
	if curl -sf --max-time 3 -X POST -H "X-Agent-Gateway-Shutdown: 1" "$$shutdown_url" >/dev/null 2>&1; then \
	  echo "  asked agent-gateway to shut down itself (POST /api/shutdown$${FORCE:+?force=1})"; \
	else \
	  echo "  /api/shutdown did not respond — server may be hung; falling back to launchctl kill"; \
	  sig=$${FORCE:+SIGINT}; sig=$${sig:-SIGTERM}; \
	  launchctl kill $$sig gui/$$(id -u)/com.jkrumm.agent-gateway 2>/dev/null || true; \
	fi; \
	i=0; while [ -n "$$old" ] && kill -0 "$$old" 2>/dev/null; do \
	  if [ $$i -gt 0 ] && [ $$((i % 120)) -eq 0 ]; then echo "  still draining ($$((i / 2))s) — a job is finishing; ^C is safe, the drain continues"; fi; \
	  sleep 0.5; i=$$((i+1)); \
	done; \
	launchctl kickstart gui/$$(id -u)/com.jkrumm.agent-gateway 2>/dev/null || true; \
	i=0; until curl -sf --max-time 2 http://127.0.0.1:7705/health >/dev/null 2>&1 || [ $$i -ge 40 ]; do sleep 0.5; i=$$((i+1)); done; \
	curl -sf --max-time 2 http://127.0.0.1:7705/health >/dev/null && echo "agent-gateway reloaded" || { echo "agent-gateway did not come back on :7705 — tail ~/Library/Logs/agent-gateway.err"; exit 1; }

# The legacy `com.jkrumm.sideclaw` and `com.jkrumm.sideclaw-server` labels (pre-rename) are booted
# out and their plists removed first. Leaving either behind is not merely untidy: the first is the
# label Background Task Management has denied, and any stale copy is a second agent racing for
# port 7705.
#
# The CURRENT label is booted out too, before the copy — not just the legacy one. Without this,
# `launchctl bootstrap` below fails on the (normal) case where the service is already loaded
# ("service already bootstrapped"), and because the `cp` above it already ran, the installed
# FILE ends up in sync with the tracked one even though launchd's LIVE definition never
# actually reloaded — silent to `reload`'s file-only drift guard, which this exact gap is what
# motivated adding the live ExitTimeOut check there too (see the comment on that target). No
# `|| true` on `bootstrap` itself: if it still fails after a clean bootout, that is a real
# problem (e.g. a plist syntax error) and this target must fail loudly, not swallow it.
#
# The OLD PID is captured and POLLED AWAY before `cp` + `bootstrap` run — `launchctl bootout` is
# a request, not a guaranteed-blocking wait, and if a job is running the old process can still
# be mid-drain (up to SIGNAL_DRAIN_GRACE_MS — this target signals the old process directly via
# `bootout`/`launchctl kill`, it never goes through POST /api/shutdown, so it's bounded by the
# short signal-side window, not HTTP_DRAIN_GRACE_MS) holding :7705 when `bootstrap` spawns the
# new instance via RunAtLoad. Racing the two means the new process's `app.listen()` fails to bind
# and it crash-loops — while every one of `bootout`/`cp`/`bootstrap` still exits 0, since none of
# them fail merely because a DIFFERENT process couldn't bind a port. Without the poll (and the
# health check at the end), this target reported "installed and started" regardless. Same
# uncapped loop as `reload`'s own poll (no `-lt N` ceiling — see the comment on that target);
# tests/shutdown-window.test.ts's Makefile check pins that neither loop has one.
#
# Same job-in-flight guard as `reload`, for the same reason a plist fix is often urgent (e.g.
# the ExitTimeOut drift `reload`'s own comment describes) — FORCE=1 here means what it means
# there: skip the wait, send SIGINT (forced abort, not SIGKILL — see `reload`'s FORCE comment
# for why it must stay catchable) so the old process exits immediately instead of `bootout`
# relying on its own default (SIGTERM-equivalent) termination, and accept that any running job
# is abandoned for the next boot's crash recovery to pick up.
install-agent:
	@for l in com.jkrumm.sideclaw com.jkrumm.sideclaw-server; do \
	  launchctl bootout gui/$$(id -u)/$$l 2>/dev/null || true; \
	  rm -f ~/Library/LaunchAgents/$$l.plist; \
	done
	@if [ -z "$(FORCE)" ]; then \
	  n=$$(curl -sf --max-time 3 http://127.0.0.1:7705/api/jobs/health 2>/dev/null | jq -r '.running // 0' 2>/dev/null || echo 0); \
	  if [ "$${n:-0}" != "0" ]; then echo "refusing to install-agent: $$n job(s) running — waiting is normal (jobs commonly run minutes), or FORCE=1 make install-agent discards them"; exit 1; fi; \
	fi
	@old=$$(launchctl print gui/$$(id -u)/com.jkrumm.agent-gateway 2>/dev/null | awk '/^[[:space:]]*pid = /{print $$3; exit}'); \
	if [ -n "$(FORCE)" ] && [ -n "$$old" ]; then \
	  launchctl kill SIGINT gui/$$(id -u)/com.jkrumm.agent-gateway 2>/dev/null || true; \
	fi; \
	launchctl bootout gui/$$(id -u)/com.jkrumm.agent-gateway 2>/dev/null || true; \
	i=0; while [ -n "$$old" ] && kill -0 "$$old" 2>/dev/null; do \
	  if [ $$i -gt 0 ] && [ $$((i % 120)) -eq 0 ]; then echo "  still draining ($$((i / 2))s) — a job is finishing; ^C is safe, the drain continues"; fi; \
	  sleep 0.5; i=$$((i+1)); \
	done
	cp com.jkrumm.agent-gateway.plist ~/Library/LaunchAgents/
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/com.jkrumm.agent-gateway.plist
	@i=0; until curl -sf --max-time 2 http://127.0.0.1:7705/health >/dev/null 2>&1 || [ $$i -ge 40 ]; do sleep 0.5; i=$$((i+1)); done; \
	curl -sf --max-time 2 http://127.0.0.1:7705/health >/dev/null && echo "agent-gateway LaunchAgent installed and started" || { echo "agent-gateway did not come back on :7705 after install — tail ~/Library/Logs/agent-gateway.err"; exit 1; }

# Symlink the harness-agnostic CLI (bin/agw.ts, a plain HTTP client of the job
# routes — no MCP layer) onto PATH so any tool can drive dispatch/check/review.
install-cli:
	@mkdir -p ~/.local/bin
	@ln -sf "$(CURDIR)/bin/agw.ts" ~/.local/bin/agw
	@ln -sf "$(CURDIR)/bin/sideclaw" ~/.local/bin/sideclaw
	@echo "agent-gateway CLI symlinked to ~/.local/bin/agw, deprecated shim at ~/.local/bin/sideclaw (run: agw --help)"

uninstall-agent:
	launchctl bootout gui/$$(id -u)/com.jkrumm.agent-gateway
	rm ~/Library/LaunchAgents/com.jkrumm.agent-gateway.plist
	@echo "agent-gateway LaunchAgent removed"

.PHONY: check deploy verify logs dev start reload install-agent install-cli uninstall-agent
