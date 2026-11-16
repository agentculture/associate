"""Runs: a detached ``associate run`` per checkout, started and read by id (stdlib only).

:mod:`associate.runs.service` holds the logic (``start``, ``show``, ``list_runs``, ``VERBS``);
:mod:`associate.runs.state` the state layout and the checkout lock;
:mod:`associate.runs.supervisor` the detached process that runs one ``associate run``.
"""
