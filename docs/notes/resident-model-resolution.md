# How the mesh resident's model is resolved

Investigation for plan task t1 (`docs/plans/2026-10-27-associate-multi-model-on-pi-1-1-0.md`),
made 2026-10-27 against the installed toolchain: culture 14.9.0 with
cultureagent 0.13.0, pi-acp 0.0.33, pi 1.1.0.

## Finding: `culture.yaml`'s `model:` does not reach the resident

1. culture hands the agent's `model:` to the ACP runner, which puts it in the
   `session/new` request params
   (`cultureagent/clients/acp/agent_runner.py:121-128`:
   `session_params["model"] = self.model`).
2. pi-acp's `newSession` reads only `cwd` and `mcpServers` from those params
   (`pi-acp/dist/index.js:1951-1962`); the `model` field is ignored.
3. pi-acp spawns `pi` with fixed arguments `--mode rpc --no-themes`
   (`pi-acp/dist/index.js:133-136`) — no `--provider` or `--model`.
4. pi-acp changes the model only on an explicit `session/set_model`
   (`unstable_setSessionModel`, `pi-acp/dist/index.js:2625`), and the culture
   ACP runner never sends one.
5. So the resident starts on pi's startup default. The repo's
   `.pi/settings.json` sets no `defaultProvider` or `defaultModel`, so the
   operator's user-level pi settings decide — on this machine that is
   provider `bolt`, model `worker`. The repo controls none of it.

## Consequence

Changing `culture.yaml` to `model: worker` (t19) changes nothing on its own.
The resident only happens to run `worker` because of a per-user setting
outside the repo.

## Fix

The extension now pins the session model itself. On `session_start`,
`.pi/extensions/associate/lib/provider.ts` looks up the registry's selected
model (`ASSOCIATE_MODEL`, else the registry default) with
`ctx.modelRegistry.find("associate", <lobes_role>)` and calls `pi.setModel`
when the session is on anything else (`pi-coding-agent/dist/core/extensions/types.d.ts:1274`;
the pattern `examples/extensions/preset.ts:136` uses). The model therefore
comes from the contract, not from user-level settings, and culture needs no
change (spec boundary c18).

Evidence: `tests/test_provider_wire.py::test_without_model_flags_the_session_runs_the_selected_registry_model`
runs a real pi with no `--provider`/`--model` — as pi-acp launches it — and
the first chat request reaches associate's lane as `senses`. With the fix
reverted the same test fails: the request goes to the user-level default and
never reaches the lane.

## Live check (pending)

Not yet run: start the resident with `culture start associate` and confirm
its first pi event reports the registry default model. That needs a live lane
and a bearer, and runs with t20's live acceptance.
