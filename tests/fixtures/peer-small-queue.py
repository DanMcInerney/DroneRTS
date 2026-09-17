"""Run the real native peer with a small test-only queue for backpressure checks."""
import runpy
import sys
from pathlib import Path

limit = int(sys.argv.pop(1))
network = Path(__file__).resolve().parents[2] / "network"
sys.path.insert(0, str(network))
import peer_store

assert 0 < limit < peer_store.MAX_QUEUE
peer_store.MAX_QUEUE = limit
runpy.run_path(str(network / "peer.py"), run_name="__main__")
