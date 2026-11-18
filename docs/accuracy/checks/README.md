# Task checks

Every task in `docs/accuracy/tasks.json` is checked twice, by hand, against
the repository it asks about at its pinned commit. This directory holds the
records. It is part of the answer key: it is removed from the clone a measured
model sees, with the rest of `docs/accuracy/`.

## Files

- `<task-id>.first.md`: the first check, by the agent that wrote the task.
  It names the commands run at the pinned commit, what they printed, and the
  finding.
- `<task-id>.second.md`: the second check, by a separate agent that has not
  seen the first check (written after the first check is finished).
- `repository-check.md`: whether every expected text of each of the 24
  tasks is found at its pinned commit, or printed there by the task's derived
  command. CI holds only this repository, so the sibling-repository rows of
  `tests/test_measure_task_set.py` skip there; this file is the record that
  they were run.
- `saved-answers.md`: the saved model answers to the six tasks converted from
  the 2026-11-17 set, how the expected values marked each before and after
  they were widened, and the hand judgement of each.

## What a second checker is given

For each task, exactly two things:

1. the task prompt, with the task id, the repository (host, owner, name) and
   the pinned commit;
2. the repository at that pinned commit.

Print the first part, and nothing else from the task file, with:

```bash
python3 -I -c 'import json; [print(t["id"], t["repository"]["name"], t["commit"], t["prompt"], sep="\n", end="\n\n") for t in json.load(open("docs/accuracy/tasks.json"))["tasks"]]'
```

A second checker is not given, and does not open: the rest of `tasks.json`
(answers, expected values, evidence, derived commands), `answer-cases.json`,
any `*.first.md` file, `repository-check.md` or `saved-answers.md`. The
coordinator runs the command above and hands over its output, so the checker
never needs to open the task file.

Read a repository only at the pinned commit (`git show <commit>:<path>`,
`git grep <pattern> <commit> -- <paths>`, `git ls-tree <commit>`), never its
working tree, and change nothing in it. Sibling repositories are checked out
beside this one; take each from the `name` in the task.

## What a second checker writes

One file per task, `docs/accuracy/checks/<task-id>.second.md`, holding:

- what the checker was given (the two items above) and a statement that it did
  not see the first check or any other file listed above;
- the commands run at the pinned commit and what they printed;
- the checker's own answer to the prompt, written before comparing with
  anything.

## Comparing the two checks

After both checks exist, the coordinator compares each second answer with the
task's recorded answer and first check. Every disagreement is written down in
`disagreements.md` with how it was settled (which check was right, by what
command at the pinned commit) and whether the task, its answer or its expected
values changed. A task with an unsettled disagreement is not kept in the set.
