"""Per-task pass rate, time and cost of Harbor jobs, side by side. Usage: report.py job-dir [job-dir ...]

A trial that failed on the machine (a network or Docker fault) is left out of the rate and counted apart.
"""

import json
import sys
from datetime import datetime
from pathlib import Path

INFRA = ("RuntimeError", "NetworkConnectionError", "AgentSetupTimeoutError")


def seconds(span: dict) -> float:
    if not span.get("finished_at"):
        return 0.0
    parse = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))  # noqa: E731
    return (parse(span["finished_at"]) - parse(span["started_at"])).total_seconds()


def trials(job: Path) -> dict[str, list[dict]]:
    """Each task's trials: reward (None for a machine fault), agent seconds, cost."""
    by_task: dict[str, list[dict]] = {}
    for result in sorted(job.glob("*/result.json")):
        r = json.loads(result.read_text())
        error = (r.get("exception_info") or {}).get("exception_type")
        reward = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        by_task.setdefault(result.parent.name.split("__")[0], []).append(
            {
                "reward": None if error in INFRA else (reward or 0.0),
                "seconds": seconds(r.get("agent_execution") or {}),
                "cost": (r.get("agent_result") or {}).get("cost_usd") or 0.0,
            }
        )
    return by_task


def main(dirs: list[str]) -> None:
    jobs = {Path(d).name: trials(Path(d)) for d in dirs}
    tasks = sorted({t for job in jobs.values() for t in job})
    print("task".ljust(28) + "".join(f"{name[:24]:>26}" for name in jobs))
    for task in tasks:
        cells = []
        for job in jobs.values():
            runs = [t for t in job.get(task, []) if t["reward"] is not None]
            cells.append(f"{sum(t['reward'] for t in runs):.0f}/{len(runs)}" if runs else "-")
        print(task.ljust(28) + "".join(f"{c:>26}" for c in cells))
    for name, job in jobs.items():
        runs = [t for ts in job.values() for t in ts]
        scored = [t for t in runs if t["reward"] is not None]
        solved = sum(t["reward"] for t in scored)
        print(
            f"{name}: {solved:.0f}/{len(scored)} solved ({100 * solved / max(1, len(scored)):.0f}%), "
            f"${sum(t['cost'] for t in runs):.4f}, {sum(t['seconds'] for t in runs):.0f} s agent time, "
            f"{len(runs) - len(scored)} machine faults left out"
        )


if __name__ == "__main__":
    main(sys.argv[1:])
