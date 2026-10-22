"""Harbor agent for Agency: uploads a compiled Agency binary to the task container and runs `agency -p` there.

Build the binaries first: bun scripts/build.ts --targets bun-linux-x64,bun-linux-x64-musl,bun-linux-arm64
Run: harbor run -d terminal-bench@2.0 -m anthropic/claude-haiku-5-5 \
       --agent-import-path agency_agent:Agency   (with packages/eval/harbor on PYTHONPATH)
AGENCY_DIST names another folder of binaries; AGENCY_MAX_STEPS sets the step limit (default 300).
"""

import json
import os
import shlex
import tomllib
from pathlib import Path, PurePosixPath
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

DIST = Path(os.environ.get("AGENCY_DIST") or Path(__file__).resolve().parents[3] / "dist")
ROOT = PurePosixPath("/installed-agent")
BINARY = ROOT / "agency"
OUTPUT = "agency.json"


def binary_for(machine: str, musl: bool) -> str:
    """The release binary that runs on a container of this `uname -m` and libc."""
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine.strip())
    if arch is None:
        raise RuntimeError(f"no Agency build for the machine {machine.strip()!r}")
    return f"agency-linux-{arch}{'-musl' if musl else ''}"


def time_limit(trial_dir: Path) -> float | None:
    """The agent time of the task this trial runs (task.toml times the job's multipliers), or None if unknown."""
    try:
        trial = json.loads((trial_dir / "config.json").read_text())
        task = tomllib.loads((Path(trial["task"]["path"]) / "task.toml").read_text())
        seconds = (trial.get("agent") or {}).get("override_timeout_sec") or task["agent"]["timeout_sec"]
        job = json.loads((Path(trial["trials_dir"]) / "config.json").read_text())
        factor = job.get("agent_timeout_multiplier") or job.get("timeout_multiplier") or 1
        return float(seconds) * float(factor)
    except (OSError, KeyError, TypeError, ValueError):
        return None


def result_of(output: str) -> dict:
    """The JSON result that `agency -p --format json` prints last, or {} if there is none."""
    start = output.find("{")
    if start == -1:
        return {}
    try:
        return json.loads(output[start:])
    except json.JSONDecodeError:
        return {}


def usage_of(output: str) -> dict:
    return result_of(output).get("usage") or {}


class Agency(BaseInstalledAgent):
    # Agency reads the provider's own key variable (ANTHROPIC_API_KEY, OPENROUTER_API_KEY, ...).
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)

    @staticmethod
    @override
    def name() -> str:
        return "agency"

    @override
    def get_version_command(self) -> str | None:
        return f"{BINARY} --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        probe = await self.exec_as_root(
            environment,
            command="uname -m; if [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; then echo musl; fi",
        )
        lines = (probe.stdout or "").split()
        musl = "musl" in lines
        local = DIST / binary_for(lines[0] if lines else "", musl)
        if musl:
            # Bun's musl runtime links the C++ runtime that Alpine leaves out.
            await self.exec_as_root(environment, command="apk add --no-cache libstdc++ libgcc")
        if not local.is_file():
            raise RuntimeError(f"{local} is missing: build it with scripts/build.ts")
        await self.exec_as_root(environment, command=f"mkdir -p {ROOT}")
        await environment.upload_file(local, str(BINARY))
        await self.exec_as_root(environment, command=f"chmod 755 {BINARY} && {BINARY} --version")
        # `run` goes as the agent user, which must own this folder.
        if environment.default_user is not None:
            owner = shlex.quote(str(environment.default_user))
            await self.exec_as_root(environment, command=f"chown -R {owner} {ROOT}")

    @override
    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("the model name must be provider/model, e.g. anthropic/claude-haiku-5-5")
        log = self.environment_logs_dir / OUTPUT
        env = {
            **self.model_connection.env,
            # In the trial's log folder: the session and trace outlive the container, also after a timeout.
            "AGENCY_HOME": f"{self.environment_logs_dir}/home",
            "AGENCY_AGENTS_HOME": f"{ROOT}/agents",
        }
        steps = os.environ.get("AGENCY_MAX_STEPS", "300")
        # Agency ends its turn before Harbor kills it: the result and its usage are then written.
        limit = time_limit(self.logs_dir.parent)
        max_time = f"--max-time {int(limit * 0.9 - 15)} " if limit and limit > 120 else ""
        # The exit code is not the verdict: the task's tests are. A failed run still leaves its usage in the log.
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {self.environment_logs_dir}; {BINARY} -p {shlex.quote(instruction)} "
                f"--model {shlex.quote(self.model_name)} --permission-mode allow-all --max-steps {steps} {max_time}"
                f"--format json > {log} 2> {self.environment_logs_dir}/agency.err || true"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output = self.logs_dir / OUTPUT
        if not output.exists():
            return
        result = result_of(output.read_text())
        usage = result.get("usage") or {}
        context.n_input_tokens = usage.get("inputTokens")
        context.n_cache_tokens = usage.get("cachedInputTokens")
        context.n_output_tokens = usage.get("outputTokens")
        context.cost_usd = usage.get("costUsd")
        keys = ("duration_ms", "num_turns", "num_tool_calls", "num_tool_errors", "stopReason", "budgetExceeded")
        context.metadata = {key: result[key] for key in keys if key in result}
