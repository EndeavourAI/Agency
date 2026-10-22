"""Harbor's Claude Code agent with a fast install: the native `claude` binary is uploaded, not set up in the container.

Harbor's own install apt-installs Node.js and downloads Claude Code in every container: about 5 minutes before the
first step, against seconds for Agency's upload. Same run, prompts and logs; only the install differs.
Get the binary once: curl -fsSL https://downloads.claude.ai/claude-code-releases/bootstrap.sh | bash, then point
CLAUDE_BINARY at ~/.local/share/claude/versions/<version>. Run: --agent-import-path claude_code_fast:FastClaudeCode
"""

import os
from pathlib import Path
from typing import override

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment


class FastClaudeCode(ClaudeCode):
    @override
    async def install(self, environment: BaseEnvironment) -> None:
        binary = Path(os.environ.get("CLAUDE_BINARY", ""))
        probe = await self.exec_as_root(
            environment,
            command="uname -m; if [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -qi musl; then echo musl; fi",
        )
        found = (probe.stdout or "").split()
        # The binary is glibc x64: another container takes Harbor's install.
        if not binary.is_file() or found[:1] != ["x86_64"] or "musl" in found:
            await super().install(environment)
            return
        await environment.upload_file(binary, "/tmp/claude")
        await self.exec_as_agent(
            environment,
            command=(
                'mkdir -p "$HOME/.local/bin" && install -m 755 /tmp/claude "$HOME/.local/bin/claude" && '
                "echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.bashrc && "
                'export PATH="$HOME/.local/bin:$PATH" && claude --version'
            ),
        )
