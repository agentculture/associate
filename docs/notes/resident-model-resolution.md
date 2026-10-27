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

## Fix (lands after t6)

pi extensions can select the session model themselves: `pi.setModel(model)`
(`pi-coding-agent/dist/core/extensions/types.d.ts:1274`, used by
`examples/extensions/preset.ts:136`). The associate extension sets the session
model on `session_start` from the contract registry's default model
(overridable by `ASSOCIATE_MODEL`), so the model comes from the contract, not
from user-level settings, and culture needs no change (spec boundary c18).

That code belongs in `.pi/extensions/associate/lib/provider.ts`, which t6
rewrites to register one provider per registry model, so the fix and its live
check follow t6.

## Live check (pending)

After the fix: start the resident with `culture start associate` and confirm
its first pi event reports model `worker`.
