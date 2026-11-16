# Cited into this repo from qodo-cli qodo/cli/_commands/tokens.py @
#  9ac0a9c4f1d7a93507ccc15295f565123025e1e1
# (cite-don't-import: this repo owns its copy and may change it.)
# Adapted: names, ASSOCIATE_ variables and the token file module (associate.server.tokenstore); the
#          overview and --json flag are this repo's (no add_json_flag helper here).
"""``associate tokens`` — issue, list and revoke the HTTP API's service tokens.

Admin verbs over the token file (``associate.server.tokenstore``; mode 0600, hashes only):
whoever can read
and write the file administers the tokens, so these verbs need no server. The plain token is
printed once, by ``issue``, and is never stored or logged. Standard library only (no extra).
"""

from __future__ import annotations

import argparse
import getpass

from associate.bridge.principal import ROLES
from associate.bridge.tokens import TokenError
from associate.cli._commands.overview import emit_overview
from associate.cli._errors import EXIT_ENV_ERROR, EXIT_USER_ERROR, CliError
from associate.cli._output import emit_result


def _json(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", help="Emit structured JSON.")


_PATH_HELP = "service-token file (default: ASSOCIATE_SERVER_TOKENS or the XDG state directory)"


def _tokens(args: argparse.Namespace):
    from associate.server.tokenstore import open_tokens

    return open_tokens(getattr(args, "tokens", None))


def _operator() -> str:
    try:
        return f"cli:{getpass.getuser()}"
    except Exception:  # noqa: BLE001 - no passwd entry in a container: still a valid issuer
        return "cli"


def _guard(call):
    """Run a token-store call; a refused request is a user error, a broken file an env error."""
    try:
        return call()
    except TokenError as err:
        raise CliError(
            code=EXIT_USER_ERROR,
            message=err.message,
            remediation="see `associate tokens list` for the ids",
        ) from err
    except (OSError, ValueError) as err:
        raise CliError(
            code=EXIT_ENV_ERROR,
            message=f"the token file cannot be used: {err}",
            remediation="check the --tokens path (or ASSOCIATE_SERVER_TOKENS) and its permissions",
        ) from err


def cmd_issue(args: argparse.Namespace) -> int:
    store = _tokens(args)
    issued = _guard(lambda: store.issue(_operator(), name=args.name, roles=[args.role]))
    json_mode = bool(getattr(args, "json", False))
    if json_mode:
        emit_result({**issued.record, "token": issued.token}, json_mode=True)
    else:
        emit_result(
            f"{issued.token}\n\nissued token {issued.id} for {issued.record['identity']!r} "
            f"(role {args.role}). The token is shown once and not stored: keep it now.",
            json_mode=False,
        )
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    rows = _guard(_tokens(args).list)
    if getattr(args, "json", False):
        emit_result({"tokens": rows}, json_mode=True)
        return 0
    lines = [
        f"{r['id']}  {', '.join(r['roles']):7}  {r['identity']}  "
        f"{'revoked ' + r['revoked_at'] if r.get('revoked_at') else 'active'}"
        for r in rows
    ]
    emit_result("\n".join(lines) if lines else "no tokens", json_mode=False)
    return 0


def cmd_revoke(args: argparse.Namespace) -> int:
    row = _guard(lambda: _tokens(args).revoke(args.id, _operator()))
    json_mode = bool(getattr(args, "json", False))
    emit_result(row if json_mode else f"revoked token {args.id}", json_mode=json_mode)
    return 0


def cmd_overview(args: argparse.Namespace) -> int:
    emit_overview(
        "associate tokens",
        [
            {
                "title": "Verbs",
                "items": [
                    "tokens issue --name N --role viewer|editor|admin — print a new token once",
                    "tokens list — ids, identities, roles and state (never a token or its hash)",
                    "tokens revoke ID — stop a token working",
                    "tokens overview — describe this noun (this command)",
                ],
            },
            {
                "title": "Where",
                "items": [
                    "--tokens PATH, ASSOCIATE_SERVER_TOKENS, or the XDG state directory file"
                ],
            },
        ],
        json_mode=bool(getattr(args, "json", False)),
    )
    return 0


def register(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser("tokens", help="Issue, list and revoke the HTTP API's service tokens.")
    _json(p)
    p.set_defaults(func=cmd_overview, json=False)
    group = p.add_subparsers(dest="tokens_command", parser_class=type(p))

    issue = group.add_parser("issue", help="Issue a service token (printed once).")
    _json(issue)
    issue.add_argument("--name", required=True, help="who the token is for (its identity)")
    issue.add_argument("--role", required=True, choices=list(ROLES), help="the role it grants")
    issue.add_argument("--tokens", help=_PATH_HELP)
    issue.set_defaults(func=cmd_issue)

    lst = group.add_parser("list", help="List tokens (never the token or its hash).")
    _json(lst)
    lst.add_argument("--tokens", help=_PATH_HELP)
    lst.set_defaults(func=cmd_list)

    revoke = group.add_parser("revoke", help="Revoke a token by id.")
    _json(revoke)
    revoke.add_argument("id", help="the token id (from `tokens list`)")
    revoke.add_argument("--tokens", help=_PATH_HELP)
    revoke.set_defaults(func=cmd_revoke)

    ov = group.add_parser("overview", help="Describe the tokens noun.")
    _json(ov)
    ov.set_defaults(func=cmd_overview)
