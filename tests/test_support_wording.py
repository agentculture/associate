"""No text of the support-score work calls the score or a count accuracy (plan task t13).

The support score says how much of a fact's value its quote shows. The counts
beside it say how many quotes were found and how many facts the decider
answered. None of them says a value is true, so no user-facing string or
document of this work may call one of them accuracy, accurate, correct, or a
score of correctness, or say that one of them shows a value is true.

The rule, per sentence:

1. Proper names are removed first (``ALLOWED_NAMES``): the file
   ``accuracy.json``, the package ``associate/accuracy``, "the accuracy
   method", ``docs/accuracy/`` and the like. A backticked ``accuracy`` is a
   name only as part of a longer identifier or next to a word that says it is
   a key ("the `accuracy` key", "beside `accuracy`"). Emphasis and plain
   quotes around the word exempt nothing.
2. Every term (``TERMS``) left in the sentence is examined, and one that no
   denial covers makes the sentence a finding. A denial covers a term when a
   negating word (``NEGATORS``) is one of the ``NEAR`` words before it in the
   same clause, or when that clause states this rule (``RULE_STATED``: "a test
   fails if a text calls it accuracy"). A clause ends at a comma, semicolon,
   colon, dash, " and " or " but ". A term that follows a covered term as the
   next member of a list ("accuracy, accurate, or a score of truth") is covered
   too.
3. In a file that is not only about the support score (a mixed file), the
   sentence must also name the score or one of its counts (``SUBJECT``) to be
   a finding. In a file that is only about the score (``DEDICATED``) every
   sentence is taken to be about it.

Which files: ``DEDICATED``; the hand-kept ``MIXED`` list; every other tracked
text file that mentions the support score (``discovered()``, from
``git ls-files``, so an untracked file is never read); the ``support_score``
block of ``accuracy.json``; and each changelog entry from ``CHANGELOG_FROM``.
Discovery leaves out tests and fixtures, the data sets under
``docs/accuracy``, ``.devague/``, vendored skills and ``node_modules``.

What the rule cannot see:

- in a mixed file, a claim that names its subject only as "the score", "the
  count", "it" or "they", or in a sentence before;
- a claim in words that are not in ``TERMS`` ("the score tells you how good
  the model is"), or one split across two sentences;
- a denial that is real but stands further off than ``NEAR`` words or across a
  clause break is reported as a finding; the sentence has to be reworded;
- a negating word close before a term that negates something else ("the
  score, with no delay, is accuracy" is caught by the comma; "a score with no
  gaps is accuracy" is not);
- a file that speaks of the score without the words "support score" or
  ``support_score`` and is in neither list;
- text outside comments and string literals in code, and anything in the
  places discovery leaves out.
"""

from __future__ import annotations

import ast
import io
import json
import re
import shutil
import subprocess
import tokenize
from pathlib import Path
from typing import Any, Iterable, Iterator

import pytest

REPO = Path(__file__).resolve().parent.parent
EXT = ".pi/extensions/associate"


def _any(patterns: Iterable[str]) -> str:
    """One pattern that matches any of *patterns*."""
    return "(?:" + "|".join(f"(?:{p})" for p in patterns) + ")"


#: The words the score and its counts must not be called. A longer form stands before the
#: shorter one it holds, so "score of correctness" is one term and not two.
TERM_FORMS = (
    r"accuracy|accuracies|accurate(?:ly)?",
    r"scores? of (?:correctness|truth)",
    r"(?:correctness|correct|truth) (?:rate|score)s?",
    r"rates? of correct\w*",
    r"correctness|how correct|(?:is|are) correct",
    # the direct claim: the score "says the value is true", a pass "proves the value true"
    r"(?:says?|shows?|means?|proves?|makes?) (?:that )?(?:the|a) (?:value|fact) (?:is )?true",
    # the same claim in other words: "a true measure of the worker", "how right the model is"
    r"true measures?|how right",
)
TERMS = re.compile(rf"\b{_any(TERM_FORMS)}\b", re.IGNORECASE | re.ASCII)

#: Words that mark a backticked ``accuracy`` as the name of a key, not a claim.
_KEY_WORDS = r"(?:key|block|fields?|object|section|beside)"

#: Proper names that hold a term and call nothing accuracy. Removed before the search.
ALLOWED_NAMES = (
    r"[\w.-]*accuracy[\w-]*\.(?:json|md|py|ts)\b",  # accuracy.json, accuracy.schema.json, notes
    r"\b(?:associate|docs|evidence|fixtures)[/.]accuracy\b",  # the package and the directories
    r"\b[\w-]+-accuracy-[\w-]+\b",  # slugs: associate-accuracy-method
    r"\baccuracy-(?:checks|live-acceptance)\b",  # the two notes, named without a suffix
    r"\baccuracy method\b",  # the method of issue #20
    r"\baccuracy rules\b",  # the heading in each model prompt
    r"\baccuracy_\w+|\w+_accuracy\b",  # identifiers: accuracy_result, load_accuracy
    r"\.accuracy\b|\baccuracy\.\w",  # attributes: contract.accuracy, accuracy.min_quote_length
    rf"``?accuracy``? {_KEY_WORDS}\b",  # the key, named as one: the `accuracy` key
    rf"\b{_KEY_WORDS} ``?accuracy``?",  # the same, the other way round: beside `accuracy`
    r"\bCLEF for accuracy\b",  # the title of issue #31
    r"\Aaccuracy\Z",  # a string that is only the key
)
_ALLOWED = re.compile(_any(ALLOWED_NAMES), re.IGNORECASE | re.ASCII)

#: A negating word. It covers a term only from close by, in the same clause.
NEGATORS = re.compile(
    r"\b(?:not|never|no|none|neither|nor|without|cannot)\b|n't\b", re.IGNORECASE | re.ASCII
)

#: The statement of this rule ("a test fails if a text calls it accuracy", "no text of this work
#: calls it accuracy"). It covers a term anywhere later in its clause.
RULE_STATED = re.compile(
    r"\bfails? (?:if|when)\b|\bno (?:text|sentence|document|string)s?\b", re.IGNORECASE
)

#: Where a clause ends: a denial before one of these does not reach a term after it.
CLAUSE_BREAK = re.compile(r"[,;:–—]| - | and | but ", re.IGNORECASE)

#: How many words before a term a negating word may stand, itself included.
NEAR = 6

#: What may stand between two terms of one list: "accuracy, accurate, or a score of truth".
_LIST_GAP = re.compile(r",? (?:(?:or|and|nor) )?(?:(?:an?|the) )?", re.IGNORECASE)

#: What a sentence in a mixed file must name before it counts as being about the support
#: score: the score itself or one of its counts. A bare "score", "count", "share" or "pass" is
#: not enough, so a benchmark line that reports an accuracy is left alone.
SUBJECT_FORMS = (
    r"support[ _-]?(?:scor\w+|checks?|answers?|marks?|question)",
    r"support_\w+",
    r"supports? the value",
    r"quote[- ](?:found|check\w*)",
    r"passed (?:facts?|count|share)",
    r"scored facts?",
    r"(?:facts?|shares?) pass(?:ed|es)?",
)
SUBJECT = re.compile(rf"\b{_any(SUBJECT_FORMS)}\b", re.IGNORECASE | re.ASCII)

#: Files that are only about the support score: every sentence is checked.
DEDICATED = (
    "associate/accuracy/support.py",
    "scripts/support_shares.py",
    f"{EXT}/lib/support.ts",
    f"{EXT}/lib/supportswitch.ts",
    "docs/notes/support-score-calibration.md",
    "docs/notes/support-score-broad-measurement.md",
    "docs/accuracy/support-labelling-guideline.md",
    "docs/accuracy/broad-difference-threshold.md",
    "docs/deliveries/2026-11-19-associate-decider-fact-score.md",
)

#: Files that also speak of other things: a sentence is checked when it names the score or one
#: of its counts. These are scanned whatever they say; ``discovered()`` adds every other tracked
#: text file that mentions the support score.
MIXED = (
    "CLAUDE.md",
    "AGENTS.md",
    "README.md",
    "docs/notes/accuracy-checks.md",
    "docs/specs/2026-11-18-associate-decider-fact-score.md",
    "docs/plans/2026-11-19-associate-decider-fact-score.md",
    "docs/plans/2026-11-19-associate-decider-fact-score-split.md",
    f"{EXT}/index.ts",
    f"{EXT}/lib/contract.ts",
    f"{EXT}/lib/render.ts",
    f"{EXT}/lib/handback.ts",
    f"{EXT}/tools/check.ts",
    f"{EXT}/prompts/worker.md",
    f"{EXT}/prompts/senses.md",
    f"{EXT}/prompts/cortex.md",
    f"{EXT}/prompts/super-vl.md",
    "associate/accuracy/__init__.py",
    "associate/cli/_commands/run.py",
    "associate/cli/_commands/check.py",
    "associate/cli/_commands/measure.py",
    "associate/cli/_commands/measure_broad.py",
    "associate/cli/_commands/learn.py",
    "associate/explain/catalog.py",
    "associate/harness/pi.py",
    "associate/measure/answer.py",
    "associate/measure/broad.py",
    "associate/measure/report.py",
    "associate/measure/runner.py",
    "associate/measure/sheet.py",
    "associate/contract/schemas/accuracy.schema.json",
    "associate/contract/schemas/report.schema.json",
)

#: The first changelog entry of this work; it and every later entry are checked.
CHANGELOG_FROM = (0, 14, 0)

#: A tracked text file that holds one of these is scanned as a mixed file.
MENTION = re.compile(r"support[_ ]score", re.IGNORECASE)

#: The kinds of file discovery reads.
TEXT_SUFFIXES = (".md", ".py", ".ts", ".json")

#: Never discovered: tests and their fixtures (they hold the bad sentences on purpose), vendored
#: skills, plan records, data sets, and the changelog (checked by entry, from ``CHANGELOG_FROM``).
SKIPPED_PARTS = frozenset({"tests", "fixtures", "node_modules", ".devague"})
SKIPPED_PREFIXES = (".claude/skills/",)
SKIPPED_FILES = frozenset({"CHANGELOG.md", "uv.lock"})
_DATA_SET = re.compile(r"docs/accuracy/[^/]+\.json")

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")
_NEW_UNIT = re.compile(r"^\s*(?:[-*+] |\d+\. |\||#{1,6} |>)")
_TS_STAR = re.compile(r"^\s*\*+ ?")
_TS_TOKEN = re.compile(
    r"/\*.*?\*/|//[^\n]*" r"|\"(?:\\.|[^\"\\\n])*\"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`",
    re.DOTALL,
)


# --- the rule --------------------------------------------------------------------------------


def findings(text: str, *, dedicated: bool) -> list[str]:
    """The sentences of *text* that call the score or a count accuracy."""
    found = []
    for sentence in sentences(text):
        bare = _ALLOWED.sub(" ", sentence)
        if claims(bare) and (dedicated or SUBJECT.search(bare)):
            found.append(sentence)
    return found


def claims(bare: str) -> bool:
    """Whether a term of *bare* stands with no denial that covers it; every term is examined."""
    last_end, last_denied = -1, False
    for term in TERMS.finditer(bare):
        in_list = last_denied and _LIST_GAP.fullmatch(bare, last_end, term.start()) is not None
        last_denied = in_list or denied(bare, term.start())
        last_end = term.end()
        if not last_denied:
            return True
    return False


def denied(bare: str, start: int) -> bool:
    """Whether the term at *start* is denied from inside its own clause."""
    clause = CLAUSE_BREAK.split(bare[:start])[-1]
    if RULE_STATED.search(clause):
        return True
    near = " ".join(clause.split()[-NEAR:])
    return NEGATORS.search(near) is not None


def sentences(text: str) -> Iterator[str]:
    """Prose sentences: wrapped lines joined, a list item or table row starting its own."""
    block: list[str] = []
    for line in [*text.splitlines(), ""]:
        if block and (not line.strip() or _NEW_UNIT.match(line)):
            yield from _split(" ".join(block))
            block = []
        if line.strip():
            block.append(line.strip())


def _split(block: str) -> Iterator[str]:
    for sentence in _SENTENCE_END.split(block):
        if sentence.strip():
            yield sentence.strip()


# --- reading the files -----------------------------------------------------------------------


def python_texts(source: str) -> list[str]:
    """Every string (an f-string as one text) and every run of comment lines in a Python source."""
    tree = ast.parse(source)
    texts = []
    inside_fstring: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.JoinedStr):
            parts = [v.value if isinstance(v, ast.Constant) else "{}" for v in node.values]
            texts.append("".join(str(part) for part in parts))
            inside_fstring.update(id(v) for v in node.values)
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) not in inside_fstring:
                texts.append(node.value)
    comments: list[str] = []
    last_row = -2
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type != tokenize.COMMENT:
            continue
        line = token.string.lstrip("#: ").strip()
        if comments and token.start[0] == last_row + 1:
            comments[-1] += "\n" + line
        else:
            comments.append(line)
        last_row = token.start[0]
    return texts + comments


def typescript_texts(source: str) -> list[str]:
    """Every comment and every string or template literal in a TypeScript source.

    A scanner by regular expression, not a parser: a quote inside a regular
    expression literal can make it misread the rest of that line.
    ``test_the_scan_reaches_the_texts_it_is_for`` checks it on the real files.
    """
    texts: list[str] = []
    last_comment_end = -1
    for match in _TS_TOKEN.finditer(source):
        token = match.group(0)
        if token.startswith("/*"):
            lines = token[2:-2].splitlines()
            texts.append("\n".join(_TS_STAR.sub("", line) for line in lines))
        elif token.startswith("//"):
            line = token.lstrip("/").strip()
            if texts and match.start() == _next_line(source, last_comment_end):
                texts[-1] += "\n" + line
            else:
                texts.append(line)
            last_comment_end = match.end()
            continue
        else:
            texts.append(token[1:-1])
        last_comment_end = -1
    return texts


def _next_line(source: str, end: int) -> int:
    """Where the text of the line after position *end* begins, or -1."""
    if end < 0:
        return -1
    newline = source.find("\n", end)
    if newline < 0 or source[end:newline].strip():
        return -1
    rest = source[newline + 1 :]
    return newline + 1 + len(rest) - len(rest.lstrip(" \t"))


def json_strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from json_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from json_strings(item)


def texts_of(relative: str) -> list[str]:
    source = (REPO / relative).read_text(encoding="utf-8")
    if relative.endswith(".py"):
        return python_texts(source)
    if relative.endswith(".ts"):
        return typescript_texts(source)
    if relative.endswith(".json"):
        return list(json_strings(json.loads(source)))
    return [source]


def changelog_entries() -> list[tuple[str, str]]:
    """(version, text) of each changelog entry from ``CHANGELOG_FROM`` on."""
    text = (REPO / "CHANGELOG.md").read_text(encoding="utf-8")
    parts = re.split(r"^## \[(\d+)\.(\d+)\.(\d+)\][^\n]*\n", text, flags=re.MULTILINE)
    entries = []
    for i in range(1, len(parts) - 3, 4):
        version = tuple(int(n) for n in parts[i : i + 3])
        if version >= CHANGELOG_FROM:
            entries.append((".".join(parts[i : i + 3]), parts[i + 3]))
    return entries


def tracked() -> list[str]:
    """Every file git tracks; an untracked file is never read."""
    git = shutil.which("git")
    assert git, "git is needed to list the tracked files"
    listed = subprocess.run([git, "ls-files", "-z"], cwd=REPO, capture_output=True, check=True)
    return [name for name in listed.stdout.decode("utf-8").split("\0") if name]


def discoverable(relative: str) -> bool:
    """Whether discovery may read *relative*: a text file outside the skipped places."""
    if not relative.endswith(TEXT_SUFFIXES) or relative in SKIPPED_FILES:
        return False
    if relative.startswith(SKIPPED_PREFIXES) or _DATA_SET.fullmatch(relative):
        return False
    return SKIPPED_PARTS.isdisjoint(Path(relative).parts)


def discovered() -> list[str]:
    """Tracked text files that mention the support score, the dedicated ones included."""
    return [
        relative
        for relative in tracked()
        if discoverable(relative)
        and (REPO / relative).is_file()
        and MENTION.search((REPO / relative).read_text(encoding="utf-8"))
    ]


def mixed_files() -> list[str]:
    """The hand-kept list and every discovered file that is not a dedicated one."""
    return sorted((set(MIXED) | set(discovered())) - set(DEDICATED))


def scan(relatives: Iterable[str], *, dedicated: bool) -> list[tuple[str, str]]:
    return [
        (relative, sentence)
        for relative in relatives
        for text in texts_of(relative)
        for sentence in findings(text, dedicated=dedicated)
    ]


# --- the rule can fail -----------------------------------------------------------------------

BAD = [
    "The support score is the model's accuracy.",
    "With the check on, 45 of 98 facts passed, an accuracy of 46%.",
    "The count of passed facts shows how accurate the worker is.",
    "support_scored is the run's score of correctness.",
    "The quote-found count is the correct rate of the hand-back.",
    "Passed facts are a truth score for the answer.",
    "The share passed measures how accurately the model reports.",
    "The answer is not scored when the decider is down. The support score is accuracy.",
    "- quote supports the value: the fact is accurate",
    "| `support_scored` | the accuracy of the run |",
    "The support score is **accuracy**.",
    "The support score is *accuracy*.",
    'The passed count is the run\'s "accuracy".',
    "The support score is `accuracy`.",
    "With the decider not down, the support score is the accuracy.",
    "There was no difference between arms; the passed count is the accuracy.",
    "The run did not fail and the support score is its accuracy.",
    "The passed count gives the model's accuracies.",
    "The support score measures correctness.",
    "The support score says the value is true.",
    "A passed fact proves that the fact is true.",
    "The count of passed facts shows how correct the model is.",
    "A passed fact is correct.",
    "The support score is not a count, it is accuracy and nothing else.",
    "The support score gives a true measure of the worker.",
    "The support mark proves the value true.",
    "The support score tells you how right the model is.",
]

GOOD = [
    "None of these counts is accuracy.",
    "Never call the support score accuracy.",
    "The count of passed facts is not accuracy and does not say a value is true.",
    "Don't call the quote-checked count accuracy.",
    "A test fails if a document calls the score or its count accuracy.",
    "Settings for the support score live in `associate/contract/accuracy.json`.",
    "The support score is part of the accuracy method (issue #20).",
    "The counts are in docs/notes/accuracy-live-acceptance.md and docs/accuracy/tasks.json.",
    "The Python copy of the support score is associate/accuracy/support.py.",
    "The scored facts sit beside `accuracy`, read by accuracy_result.",
    "The support score follows the prompt's Accuracy rules.",
    "The score is not a measure of accuracy.",
    "Never call the quote-found count accuracy.",
    "neither it nor any count of it is accuracy",
    "It does not say the value is true.",
    "A pass does not make a fact true.",
    "a passed fact means its quote was found; it does not mean the value is true",
    "The test fails when a text calls the support score accuracy, accurate, or a score of truth.",
    "The support score is stored under the `accuracy` key of the result.",
    "The `accuracy` block holds the passed count.",
    "The support score is read from `result.accuracy` by the harness.",
    "No text of this work calls the support score or a count of it accuracy.",
    "The support score is not a true measure of the worker.",
    "A support mark does not make the value true.",
]

#: Sentences of a mixed file that hold a term and are not about the support score.
ELSEWHERE = [
    "BFCL score for worker: 61% overall accuracy",
    "The grader's verdict was accurate on the held-out tasks.",
    "The share of tasks solved is the suite's accuracy, and the count is from upstream.",
    "The benchmark says the answer is correct when its tests pass.",
]


@pytest.mark.parametrize("sentence", BAD)
def test_a_sentence_that_calls_the_score_or_a_count_accuracy_is_found(sentence):
    assert findings(sentence, dedicated=False), sentence
    assert findings(sentence, dedicated=True), sentence


@pytest.mark.parametrize("sentence", GOOD)
def test_a_denial_or_a_proper_name_is_not_a_finding(sentence):
    assert findings(sentence, dedicated=False) == []
    assert findings(sentence, dedicated=True) == []


@pytest.mark.parametrize("sentence", ELSEWHERE)
def test_a_mixed_file_sentence_about_something_else_is_left_alone(sentence):
    assert findings(sentence, dedicated=False) == []
    assert findings(sentence, dedicated=True) == [sentence]


def test_emphasis_or_quotes_around_the_word_do_not_exempt_it():
    for fragment in ("is **accuracy**", 'the run\'s "accuracy"', "*accuracy*", "`accuracy`"):
        assert findings(fragment, dedicated=True) == [fragment]


def test_every_term_in_a_sentence_is_examined():
    sentence = "The support score is not accuracy; the passed count is the accuracy."
    assert findings(sentence, dedicated=False) == [sentence]


def test_a_claim_wrapped_over_two_lines_is_one_sentence():
    text = "Some text.\n\nThe support score, read over a whole run, is the\nmodel's accuracy.\n"
    assert findings(text, dedicated=False) == [
        "The support score, read over a whole run, is the model's accuracy."
    ]


def test_a_denial_in_the_sentence_before_does_not_cover_the_next_one():
    text = "This is not a benchmark. The support score is accuracy."
    assert findings(text, dedicated=False) == ["The support score is accuracy."]


def test_python_strings_and_comments_are_both_read():
    source = (
        '"""The support score is accuracy."""\n'
        "# the count of passed facts is the\n"
        "# accuracy of the run\n"
        'X = f"support score: {1} accurate"\n'
    )
    found = [s for text in python_texts(source) for s in findings(text, dedicated=False)]
    assert len(found) == 3, found


def test_typescript_comments_and_strings_are_both_read():
    source = (
        "/**\n * The support score is the\n * accuracy of a fact.\n */\n"
        'const LEGEND = "quote supports the value: accurate";\n'
        "const x = ctx.contract.accuracy.support_score;\n"
    )
    found = [s for text in typescript_texts(source) for s in findings(text, dedicated=False)]
    assert len(found) == 2, found


def test_typescript_line_comments_in_a_row_are_one_text():
    source = "// the support score is the\n  // accuracy of a fact\nconst a = 1; // unrelated\n"
    assert typescript_texts(source) == [
        "the support score is the\naccuracy of a fact",
        "unrelated",
    ]


def test_json_strings_are_read_at_any_depth():
    block = {"a": {"b": ["the support score is accuracy"]}, "n": 1}
    assert list(json_strings(block)) == ["the support score is accuracy"]


# --- the repository --------------------------------------------------------------------------


@pytest.mark.parametrize("relative", [*DEDICATED, *MIXED])
def test_every_scanned_file_exists_and_holds_text(relative):
    assert (REPO / relative).is_file(), f"{relative} moved: update the list in this test"
    assert any(text.strip() for text in texts_of(relative))


def test_the_scan_reaches_the_texts_it_is_for():
    """A known sentence of each kind of file is among the sentences read."""

    def read(relative: str) -> str:
        return " ".join(s for text in texts_of(relative) for s in sentences(text))

    assert "quote supports the value" in read(f"{EXT}/lib/render.ts")
    assert "None of the shares below is accuracy" in read("docs/notes/support-score-calibration.md")
    assert "support" in read("associate/accuracy/support.py")
    assert "support" in read("associate/cli/_commands/check.py")
    assert "--support-score" in read("associate/cli/_commands/run.py")


def test_no_file_only_about_the_support_score_calls_it_accuracy():
    assert scan(DEDICATED, dedicated=True) == []


def test_no_sentence_about_the_score_or_a_count_in_a_mixed_file_calls_it_accuracy():
    assert scan(mixed_files(), dedicated=False) == []


def test_discovery_reaches_files_no_list_names():
    found = discovered()
    assert "docs/deliveries/2026-11-19-associate-decider-fact-score.md" in found
    assert "associate/contract/validate.py" in found
    assert "CLAUDE.md" in found
    assert "associate/contract/validate.py" not in MIXED, "discovery, not the list, must reach it"
    assert "associate/contract/validate.py" in mixed_files()
    assert set(DEDICATED).isdisjoint(mixed_files())


@pytest.mark.parametrize(
    "relative",
    [
        "tests/test_support_wording.py",
        f"{EXT}/tests/support.test.ts",
        "tests/fixtures/accuracy/report.json",
        "docs/accuracy/support-labelled-set.json",
        ".devague/plans/associate-decider-fact-score.json",
        ".claude/skills/recall/SKILL.md",
        "node_modules/x/readme.md",
        "CHANGELOG.md",
        "uv.lock",
        "docs/accuracy/broad-runs.png",
    ],
)
def test_discovery_leaves_tests_data_sets_and_vendored_files_alone(relative):
    assert not discoverable(relative)


def test_discovery_reads_documents_and_sources():
    for relative in ("README.md", "associate/measure/sheet.py", f"{EXT}/lib/render.ts"):
        assert discoverable(relative)
    assert discoverable("docs/accuracy/support-labelling-guideline.md")
    assert discoverable("associate/contract/schemas/report.schema.json")


def test_the_support_score_texts_in_the_contract_do_not_call_it_accuracy():
    accuracy = json.loads((REPO / "associate/contract/accuracy.json").read_text(encoding="utf-8"))
    block = accuracy["support_score"]
    texts = list(json_strings(block)) + list(block["options"])
    assert texts, "the support_score block holds no text"
    assert [s for text in texts for s in findings(text, dedicated=True)] == []


def test_the_changelog_entries_of_this_work_do_not_call_a_count_accuracy():
    entries = changelog_entries()
    assert [version for version, _ in entries][-1] == "0.14.0", "the 0.14.0 entry was not found"
    assert [(v, s) for v, text in entries for s in findings(text, dedicated=False)] == []
