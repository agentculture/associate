"""The Python side copies each fact's support score from the export (decider-score t6).

The extension writes, when the support score is on for a run, ``facts[i].support``
in the export's ``check.json`` and ``support_scored`` in ``report.json``. The
Python re-check knows nothing of either. ``associate check`` and ``associate run
--json`` copy what the extension wrote, name the extension as its source, and
show nothing for an export that holds none. Nothing here asks the decider: the
copy opens no socket.
"""

from __future__ import annotations

import ast
import json
import socket
from pathlib import Path
from typing import Any

import pytest

from associate import contract
from associate import harness as harness_pkg
from associate.cli import main
from associate.harness.stub import StubHarness
from tests.test_accuracy_check_outputs import entry, write_export

REPO = Path(__file__).resolve().parent.parent
RESULT = "alpha is one\nbeta is two\ngamma is three\n"
SCORED_HIGH = {"status": "scored", "answer": "all", "supports": True, "confidence": 0.97}
SCORED_LOW = {"status": "scored", "answer": "none", "supports": False, "confidence": 0.03}
#: The shipped contract's options, in order (plan deviation d4).
OPTION_KEYS = list(contract.load_accuracy()["support_score"]["options"])
ANSWERS_KEY = "support_answers"


def answer_counts(**counts: int) -> dict[str, int]:
    """One count per contract option, in contract order, zeros included."""
    return {key: counts.get(key, 0) for key in OPTION_KEYS}


NOT_SCORED = {"status": "not_scored", "reason": "timeout", "detail": "after 10000 ms"}
NOT_FOUND_QUOTE = "delta is four"
#: Words the support score must never be described with.
FORBIDDEN = ("accuracy", "accurate", "pass", "fail")
COPY_KEYS = (
    "support_source",
    "support_scored",
    "support_scored_reported",
    "support_unmatched",
    ANSWERS_KEY,
)


# --- building exports ------------------------------------------------------------------------


def payload() -> dict[str, Any]:
    quotes = ("alpha is one", "beta is two", "gamma is three", NOT_FOUND_QUOTE)
    return {
        "facts": [
            {"id": f"f{n}", "value": quote.split()[-1], "source": "w1", "quote": quote}
            for n, quote in enumerate(quotes, start=1)
        ]
    }


def check_facts(support: dict[str, Any]) -> list[dict[str, Any]]:
    """check.json's facts as the extension writes them: a ``support`` only where given."""
    facts = []
    for n in range(1, 5):
        fact: dict[str, Any] = {"id": f"f{n}", "source": "w1", "verdict": "passed"}
        if fact["id"] in support:
            fact["support"] = support[fact["id"]]
        facts.append(fact)
    return facts


def export_with(
    root: Path,
    support: dict[str, Any] | None,
    *,
    reported: Any = None,
    extra_facts: list[dict[str, Any]] | None = None,
) -> Path:
    """An export of four facts (f4's quote is not in the result); no check.json for None."""
    export = write_export(root / "export", [entry(1)], {"w1": RESULT}, payload())
    if support is None:
        return export
    check = {"mode": "report", "accepted": True, "outcome": "accepted"}
    check["facts"] = [*check_facts(support), *(extra_facts or [])]
    (export / "check.json").write_text(json.dumps(check), encoding="utf-8")
    report: dict[str, Any] = {"unchecked_text": {"summary_sentences": 0}}
    if reported is not None:
        report["support_scored"] = reported
    (export / "report.json").write_text(json.dumps(report), encoding="utf-8")
    return export


def scored_export(root: Path) -> Path:
    support = {"f1": SCORED_HIGH, "f2": SCORED_LOW, "f3": NOT_SCORED}
    return export_with(root, support, reported=2)


def check_json(capsys: pytest.CaptureFixture[str], export: Path) -> dict[str, Any]:
    assert main(["check", str(export), "--json"]) == 0
    return json.loads(capsys.readouterr().out)


def check_text(capsys: pytest.CaptureFixture[str], export: Path) -> str:
    assert main(["check", str(export)]) == 0
    return capsys.readouterr().out


def by_id(result: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {fact["id"]: fact for fact in result["facts"]}


def support_lines(text: str) -> list[str]:
    """The lines of a text output that speak of the support score."""
    return [
        line for line in text.splitlines() if "support" in line.lower().replace("supported", "")
    ]


# --- associate check -------------------------------------------------------------------------


def test_check_json_copies_each_facts_support_and_names_the_extension(tmp_path, capsys):
    result = check_json(capsys, scored_export(tmp_path))
    facts = by_id(result)
    assert facts["f1"]["support"] == SCORED_HIGH
    assert facts["f2"]["support"] == SCORED_LOW
    assert facts["f3"]["support"] == NOT_SCORED
    assert "support" not in facts["f4"]  # the quote was not found: the extension scored nothing
    assert result["support_source"] == "extension"
    assert result["support_scored"] == 2
    assert result["support_scored_reported"] == 2
    assert "support_unmatched" not in result
    assert result[ANSWERS_KEY] == answer_counts(all=1, none=1)
    assert list(result[ANSWERS_KEY]) == OPTION_KEYS


def test_check_text_prints_the_answer_counts_on_one_line(tmp_path, capsys):
    text = check_text(capsys, scored_export(tmp_path))
    counts = ", ".join(f"{key} {answer_counts(all=1, none=1)[key]}" for key in OPTION_KEYS)
    assert [line for line in text.splitlines() if line.strip().startswith("answers:")] == [
        f"  answers: {counts}"
    ]


#: The words ``associate check`` shows for each shipped option, as lib/render.ts shows them.
WORDS = {
    "all": "quote supports the value",
    "mostly": "quote supports the main claim; a detail of the value is not in the quote",
    "part": "quote shows only part of the value",
    "little": "quote shows little of the value",
    "none": "quote does not show the value",
}


@pytest.mark.parametrize("answer", sorted(WORDS))
def test_check_text_shows_each_answer_in_words_and_no_number(answer, tmp_path, capsys):
    result = {"status": "scored", "answer": answer, "supports": False, "confidence": 0.42}
    text = check_text(capsys, export_with(tmp_path, {"f1": result}, reported=1))
    line = next(line for line in text.splitlines() if WORDS[answer] in line)
    assert line.strip() == f"support: {WORDS[answer]}"
    assert "0.42" not in text


def test_the_python_words_are_the_words_render_ts_writes():
    from associate.accuracy.support import ANSWER_WORDS

    source = (REPO / ".pi/extensions/associate/lib/render.ts").read_text(encoding="utf-8")
    table = source.split("const ANSWER_WORDS", 1)[1].split("};", 1)[0]
    assert ANSWER_WORDS == WORDS
    for key, words in WORDS.items():
        assert f'{key}: "{words}",' in table


def test_an_answer_with_no_words_is_shown_by_its_key(tmp_path, capsys):
    from associate.accuracy.support import describe

    shown = describe({"status": "scored", "answer": "partly", "supports": False, "confidence": 1})
    assert shown == "support answer: partly"


def test_an_answer_that_is_not_a_contract_option_is_not_available(tmp_path, capsys):
    odd = {"status": "scored", "answer": "partly", "supports": True, "confidence": 0.5}
    result = check_json(capsys, export_with(tmp_path, {"f1": odd, "f2": SCORED_HIGH}, reported=2))
    assert by_id(result)["f1"]["support"] == {
        "status": "not_available",
        "reason": "answer_not_an_option",
    }
    assert result[ANSWERS_KEY] == answer_counts(all=1)


def test_check_json_leaves_the_re_check_counts_alone(tmp_path, capsys):
    with_score = check_json(capsys, scored_export(tmp_path / "a"))
    without = check_json(capsys, export_with(tmp_path / "b", None))
    assert with_score["report"] == without["report"]
    assert with_score["accepted"] == without["accepted"]
    assert [f["verdict"] for f in with_score["facts"]] == [f["verdict"] for f in without["facts"]]


def test_check_text_says_each_facts_support_in_plain_words(tmp_path, capsys):
    text = check_text(capsys, scored_export(tmp_path))
    assert "support: quote supports the value\n" in text
    assert "support: quote does not show the value\n" in text
    assert "0.97" not in text
    assert "support not scored (timeout: after 10000 ms)" in text
    assert "copied from the extension's check.json" in text
    assert "not recomputed" in text
    assert "scored 2 of 3" in text


def test_the_support_lines_never_use_the_words_of_the_quote_check(tmp_path, capsys):
    lines = support_lines(check_text(capsys, scored_export(tmp_path)))
    assert len(lines) >= 5
    for line in lines:
        for word in FORBIDDEN:
            assert word not in line.lower(), line


@pytest.mark.parametrize("name", ["old", "off"])
def test_an_export_without_the_score_loads_and_shows_none(name, tmp_path, capsys):
    """Old: no check.json at all. Off: the extension's files, with no support field."""
    export = export_with(tmp_path, None if name == "old" else {})
    result = check_json(capsys, export)
    assert all("support" not in fact for fact in result["facts"])
    assert not [key for key in result if key.startswith("support")]
    assert support_lines(check_text(capsys, export)) == []


def test_a_run_with_the_score_on_and_nothing_scored_says_so(tmp_path, capsys):
    result = check_json(capsys, export_with(tmp_path, {}, reported=0))
    assert result["support_source"] == "extension"
    assert result["support_scored"] == 0
    assert all("support" not in fact for fact in result["facts"])


MALFORMED = {
    "not_an_object": "0.9",
    "unknown_status": {"status": "passed", "answer": "all"},
    "old_yes_no_score": {"status": "scored", "score": 0.9, "at_or_above_cutoff": True},
    "answer_missing": {"status": "scored", "supports": True, "confidence": 0.9},
    "answer_not_text": {"status": "scored", "answer": 3, "supports": True, "confidence": 0.9},
    "answer_prose": {
        "status": "scored",
        "answer": "all\nof it",
        "supports": True,
        "confidence": 0.9,
    },
    "supports_not_boolean": {
        "status": "scored",
        "answer": "all",
        "supports": "yes",
        "confidence": 1,
    },
    "confidence_text": {"status": "scored", "answer": "all", "supports": True, "confidence": "0.9"},
    "confidence_boolean": {
        "status": "scored",
        "answer": "all",
        "supports": True,
        "confidence": True,
    },
    "confidence_above_one": {
        "status": "scored",
        "answer": "all",
        "supports": True,
        "confidence": 1.5,
    },
    "confidence_below_zero": {
        "status": "scored",
        "answer": "none",
        "supports": False,
        "confidence": -0.1,
    },
    "confidence_missing": {"status": "scored", "answer": "all", "supports": True},
    "reason_missing": {"status": "not_scored"},
    "reason_long": {"status": "not_scored", "reason": "x" * 200},
    "reason_prose": {"status": "not_scored", "reason": "it failed, accuracy unknown"},
    "detail_not_text": {"status": "not_scored", "reason": "timeout", "detail": {"a": 1}},
}


@pytest.mark.parametrize("name", sorted(MALFORMED))
def test_a_malformed_entry_is_not_available_and_never_a_score(name, tmp_path, capsys):
    export = export_with(tmp_path, {"f1": MALFORMED[name], "f2": SCORED_HIGH}, reported=2)
    result = check_json(capsys, export)
    shown = by_id(result)["f1"]["support"]
    assert shown["status"] == "not_available"
    assert isinstance(shown["reason"], str)
    assert shown["reason"]
    assert set(shown) == {"status", "reason"}
    assert result["support_scored"] == 1  # f2 only; the extension's own number is kept apart
    assert result["support_scored_reported"] == 2
    assert result[ANSWERS_KEY] == answer_counts(all=1)
    text = check_text(capsys, export)
    assert f"support not available ({shown['reason']})" in text
    for line in support_lines(text):
        for word in FORBIDDEN:
            assert word not in line.lower(), line


def test_a_nan_confidence_is_not_a_score(tmp_path, capsys):
    export = export_with(tmp_path, {"f1": SCORED_HIGH})
    path = export / "check.json"
    path.write_text(path.read_text("utf-8").replace("0.97", "NaN"), encoding="utf-8")
    assert by_id(check_json(capsys, export))["f1"]["support"]["status"] == "not_available"


def test_a_long_detail_is_cut_and_keeps_to_one_line(tmp_path, capsys):
    noisy = {"status": "not_scored", "reason": "http_error", "detail": "a\nb\x1b[31m" + "z" * 900}
    export = export_with(tmp_path, {"f1": noisy})
    shown = by_id(check_json(capsys, export))["f1"]["support"]
    assert shown["status"] == "not_scored"
    assert shown["reason"] == "http_error"
    assert len(shown["detail"]) <= 200
    assert "\n" not in shown["detail"]
    assert "\x1b" not in shown["detail"]


def test_an_id_the_re_check_does_not_know_is_named_and_attached_to_nothing(tmp_path, capsys):
    extra = [{"id": "f9", "verdict": "passed", "support": SCORED_HIGH}]
    export = export_with(tmp_path, {"f1": SCORED_HIGH}, reported=2, extra_facts=extra)
    result = check_json(capsys, export)
    assert result["support_unmatched"] == ["f9"]
    assert result["support_scored"] == 1
    assert set(by_id(result)) == {"f1", "f2", "f3", "f4"}
    text = check_text(capsys, export)
    assert "f9" in text
    assert "does not know" in text


def test_a_score_on_a_fact_whose_quote_the_re_check_did_not_find_is_not_shown(tmp_path, capsys):
    export = export_with(tmp_path, {"f4": SCORED_HIGH}, reported=1)
    result = check_json(capsys, export)
    assert by_id(result)["f4"]["verdict"] == "refused"
    assert by_id(result)["f4"]["support"] == {
        "status": "not_available",
        "reason": "quote_not_found_by_recheck",
    }
    assert result["support_scored"] == 0


def test_the_same_id_twice_in_check_json_is_not_available(tmp_path, capsys):
    extra = [{"id": "f1", "verdict": "passed", "support": SCORED_LOW}]
    export = export_with(tmp_path, {"f1": SCORED_HIGH}, extra_facts=extra)
    shown = by_id(check_json(capsys, export))["f1"]["support"]
    assert shown == {"status": "not_available", "reason": "duplicate_id"}


@pytest.mark.parametrize(
    "content",
    ["{not json", "[1, 2]", '{"facts": "none"}', '{"facts": [1, null, {"id": "f1"}]}', "\xff"],
)
def test_an_unreadable_check_json_shows_no_score_and_raises_nothing(content, tmp_path, capsys):
    export = export_with(tmp_path, None)
    (export / "check.json").write_text(content, encoding="latin-1")
    result = check_json(capsys, export)
    assert all("support" not in fact for fact in result["facts"])
    assert "support_scored" not in result
    assert support_lines(check_text(capsys, export)) == []


def test_a_support_result_on_an_entry_with_no_usable_id_is_named_as_unmatched(tmp_path, capsys):
    export = export_with(tmp_path, None)
    content = {"facts": [{"support": SCORED_HIGH}, {"id": "a\nb", "support": SCORED_HIGH}]}
    (export / "check.json").write_text(json.dumps(content), encoding="utf-8")
    result = check_json(capsys, export)
    assert result["support_unmatched"] == ["<malformed id>"]
    assert result["support_scored"] == 0
    assert all("support" not in fact for fact in result["facts"])


def test_a_check_json_that_is_a_link_is_not_followed(tmp_path, capsys):
    export = export_with(tmp_path, None)
    outside = tmp_path / "outside.json"
    outside.write_text(json.dumps({"facts": check_facts({"f1": SCORED_HIGH})}), encoding="utf-8")
    (export / "check.json").symlink_to(outside)
    result = check_json(capsys, export)
    assert all("support" not in fact for fact in result["facts"])


def test_an_export_with_no_facts_still_loads_with_a_score_file_beside_it(tmp_path, capsys):
    export = write_export(tmp_path / "export", [entry(1)], {"w1": RESULT})
    (export / "check.json").write_text(
        json.dumps({"facts": check_facts({"f1": SCORED_HIGH})}), encoding="utf-8"
    )
    result = check_json(capsys, export)
    assert result["applicable"] is False
    assert result["support_unmatched"] == ["f1"]
    assert result["support_scored"] == 0
    assert "f1" in check_text(capsys, export)


# --- associate run ---------------------------------------------------------------------------


class SupportStub(StubHarness):
    """The stub, with the support results the extension would have written."""

    name = "stubsupport"
    support: Any = SCORED_HIGH

    def _write_json(self, name: str, value: Any) -> None:
        if name == "check.json" and value.get("facts"):
            first = {**value["facts"][0], "support": self.support}
            value = {**value, "facts": [first, *value["facts"][1:]]}
        if name == "report.json":
            value = {**value, "support_scored": 1, ANSWERS_KEY: answer_counts(all=1)}
        super()._write_json(name, value)


class NotScoredStub(SupportStub):
    support = NOT_SCORED


@pytest.fixture
def stubs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(harness_pkg._REGISTRY, "stubsupport", lambda: SupportStub)
    monkeypatch.setitem(harness_pkg._REGISTRY, "stubnotscored", lambda: NotScoredStub)


def run_cli(tmp_path: Path, harness: str, *flags: str) -> int:
    checkout = tmp_path / "checkout"
    checkout.mkdir(exist_ok=True)
    (checkout / "README.md").write_text("# fixture\n", encoding="utf-8")
    argv = ["run", "--harness", harness, "--model", "senses", "--checkout", str(checkout)]
    argv += ["--export-root", str(tmp_path / "runs"), "--session-id", "s1", *flags]
    return main(argv)


def test_run_json_copies_each_facts_support_and_names_the_extension(tmp_path, stubs, capsys):
    assert run_cli(tmp_path, "stubsupport", "--json") == 0
    out = json.loads(capsys.readouterr().out)
    assert out["support_source"] == "extension"
    assert out["support_scored"] == 1
    assert out["support_scored_reported"] == 1
    assert out["support_facts"][0]["support"] == SCORED_HIGH
    assert out[ANSWERS_KEY] == answer_counts(all=1)
    assert out["support_facts"][0]["id"].startswith("f")
    assert all(set(item) == {"id", "support"} for item in out["support_facts"])
    # The copy is beside the re-check's result, not in it.
    assert not [key for key in out["accuracy"] if "support" in key]
    assert "support_scored" not in out["accuracy"]["report"]


def test_run_json_shows_a_fact_that_was_not_scored(tmp_path, stubs, capsys):
    assert run_cli(tmp_path, "stubnotscored", "--json") == 0
    out = json.loads(capsys.readouterr().out)
    assert out["support_scored"] == 0
    assert out[ANSWERS_KEY] == answer_counts()
    assert out["support_facts"][0]["support"] == NOT_SCORED


def test_run_json_of_a_run_without_the_score_has_no_support_copy(tmp_path, capsys):
    assert run_cli(tmp_path, "stub", "--json") == 0
    out = json.loads(capsys.readouterr().out)
    assert not [key for key in out if key in COPY_KEYS or key == "support_facts"]


def test_run_text_says_the_count_and_where_it_came_from(tmp_path, stubs, capsys):
    assert run_cli(tmp_path, "stubsupport") == 0
    lines = [line for line in capsys.readouterr().out.splitlines() if line.startswith("support_")]
    copied = [line for line in lines if not line.startswith(("support_score=", "support_answers="))]
    assert len(copied) == 1
    assert copied[0].startswith("support_scored=1 of 1")
    counts = ", ".join(f"{key} {answer_counts(all=1)[key]}" for key in OPTION_KEYS)
    assert [line for line in lines if line.startswith("support_answers=")] == [
        f"support_answers={counts}"
    ]
    assert "copied from the extension's check.json" in copied[0]
    for word in FORBIDDEN:
        assert word not in copied[0].lower()


def test_run_text_of_a_run_without_the_score_has_no_support_line(tmp_path, capsys):
    assert run_cli(tmp_path, "stub") == 0
    out = capsys.readouterr().out
    assert "support_scored" not in out
    assert "support_facts" not in out


def test_the_run_result_of_an_old_export_is_what_the_re_check_alone_gives(tmp_path):
    from evidence.accuracy.check import accuracy_result as evidence_result

    from associate.accuracy import accuracy_result

    for name, support in (("old", None), ("off", {})):
        export = export_with(tmp_path / name, support)
        accuracy = contract.load_accuracy()
        assert accuracy_result(export, accuracy) == evidence_result(export, accuracy)


class _Counted:
    """Call counters for the run result's re-check and export reads (review finding 4)."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        import evidence.accuracy.check as evidence_check

        import associate.accuracy as accuracy_pkg
        from associate.accuracy import support as support_mod

        self.inspect_own = 0
        self.inspect_evidence = 0
        self.reads: list[str] = []
        own, theirs = accuracy_pkg.inspect_export, evidence_check.inspect_export
        read = support_mod._read_object

        def own_inspect(*args: Any, **kwargs: Any) -> Any:
            self.inspect_own += 1
            return own(*args, **kwargs)

        def evidence_inspect(*args: Any, **kwargs: Any) -> Any:
            self.inspect_evidence += 1
            return theirs(*args, **kwargs)

        def counted_read(export_dir: Path, name: str) -> dict[str, Any]:
            self.reads.append(name)
            return read(export_dir, name)

        monkeypatch.setattr(accuracy_pkg, "inspect_export", own_inspect)
        monkeypatch.setattr(evidence_check, "inspect_export", evidence_inspect)
        monkeypatch.setattr(support_mod, "_read_object", counted_read)


def test_the_run_result_reads_each_score_file_once(tmp_path, monkeypatch):
    from associate.accuracy import accuracy_result

    counted = _Counted(monkeypatch)
    result = accuracy_result(scored_export(tmp_path), contract.load_accuracy())
    assert result["support_scored"] == 2
    assert sorted(counted.reads) == ["check.json", "report.json"]


def test_the_run_result_runs_its_own_re_check_once_with_a_score(tmp_path, monkeypatch):
    from associate.accuracy import accuracy_result

    counted = _Counted(monkeypatch)
    accuracy_result(scored_export(tmp_path), contract.load_accuracy())
    # evidence-cli's own accuracy_result runs inspect_export once inside it,
    # which associate cannot change; associate adds at most one more.
    assert counted.inspect_evidence + counted.inspect_own <= 2
    assert counted.inspect_own <= 1


def test_the_run_result_of_an_export_without_a_score_runs_the_re_check_once(tmp_path, monkeypatch):
    from associate.accuracy import accuracy_result

    counted = _Counted(monkeypatch)
    accuracy_result(export_with(tmp_path, None), contract.load_accuracy())
    assert counted.inspect_evidence + counted.inspect_own == 1


# --- no network ------------------------------------------------------------------------------


def test_the_copy_opens_no_socket(tmp_path, capsys, monkeypatch):
    from associate.accuracy import accuracy_result

    def refuse(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("the support copy opened a socket")

    export = scored_export(tmp_path)
    monkeypatch.setattr(socket, "socket", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)
    assert check_json(capsys, export)["support_scored"] == 2
    assert "quote supports the value" in check_text(capsys, export)
    assert accuracy_result(export, contract.load_accuracy())["support_scored"] == 2


NETWORK_MODULES = {
    "socket",
    "ssl",
    "http",
    "urllib",
    "urllib3",
    "requests",
    "httpx",
    "aiohttp",
    "asyncio",
    "subprocess",
    "ftplib",
    "smtplib",
    "xmlrpc",
    "websocket",
    "websockets",
}


def imported_modules(path: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
    return names


def test_the_copy_imports_only_file_and_text_modules():
    """The module that does the copy imports nothing that could reach a network."""
    found = imported_modules(REPO / "associate" / "accuracy" / "support.py")
    assert found <= {"__future__", "json", "math", "re", "pathlib", "typing"}, found


@pytest.mark.parametrize(
    "path", ["associate/accuracy/__init__.py", "associate/cli/_commands/check.py"]
)
def test_the_code_that_calls_the_copy_imports_no_network_module(path):
    roots = {name.split(".")[0] for name in imported_modules(REPO / path)}
    assert not roots & NETWORK_MODULES


# --- where the output is described -----------------------------------------------------------


def explained(capsys: pytest.CaptureFixture[str], *path: str) -> str:
    assert main(["explain", *path]) == 0
    return capsys.readouterr().out


def test_explain_run_describes_the_copied_support_keys(capsys):
    out = explained(capsys, "run")
    for needle in (
        "support_source",
        "support_facts",
        "support_scored",
        "support_scored_reported",
        "support_unmatched",
        "support_answers",
        "not_available",
        "never recomputed",
    ):
        assert needle in out, needle


def test_explain_check_describes_the_copied_support(capsys):
    out = explained(capsys, "check")
    for needle in (
        "support_source",
        "`support`",
        "not_scored",
        "not_available",
        "no network",
        "support_answers",
        "`answer`",
        "`supports`",
        "`confidence`",
    ):
        assert needle in out, needle


def test_learn_says_the_support_score_is_copied_from_the_export(capsys):
    assert main(["learn"]) == 0
    text = capsys.readouterr().out
    assert "support score copied from the export" in text
    assert main(["learn", "--json"]) == 0
    commands = json.loads(capsys.readouterr().out)["commands"]
    summaries = {tuple(c["path"]): c["summary"] for c in commands}
    assert "support_source" in summaries[("check",)]
    assert "support_source" in summaries[("run",)]
