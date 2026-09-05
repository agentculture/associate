"""Entry point for ``python -m associate``."""

from __future__ import annotations

import sys

from associate.cli import main

if __name__ == "__main__":
    sys.exit(main())
