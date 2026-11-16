# Cited from qodo-cli qodo/bridge/__init__.py @
#  d87e2db7f3e84390a4662b348088c76c1ad68012
# (cite-don't-import: this repo owns its copy and may change it.)
# Adapted: none beyond this header. The file is original to qodo-cli (no culture-rules source).
"""Reusable service framework: auth, route policy, static serving and cache policy.

Cited from culture-rules (see each module's header for its source path and commit). Nothing
here knows the app that hosts it: the environment prefix, token prefix, dev header and web build
directory are parameters, and the route-to-role table is filled in through ``policy.RoutePolicy``.
Standard library only, except ``static`` (the ``server`` extra, imported lazily).
"""
