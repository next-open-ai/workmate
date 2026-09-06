from __future__ import annotations

from typing import Any

from agentscope.permission import PermissionBehavior, PermissionDecision
from agentscope.permission._context import PermissionContext
from agentscope.skill import Skill
from agentscope.tool import ToolBase, Toolkit


class HostExternalTool(ToolBase):
    """Tool executed by the TypeScript host via JSON-RPC `host.tool.invoke`."""

    is_external_tool = True
    is_concurrency_safe = True

    def __init__(
        self,
        *,
        name: str,
        description: str,
        input_schema: dict[str, Any],
        is_read_only: bool = True,
        permission: PermissionBehavior = PermissionBehavior.ALLOW,
        capability: str | None = None,
    ) -> None:
        super().__init__()
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self.is_read_only = is_read_only
        self._permission = permission
        self.capability = capability

    async def check_permissions(
        self,
        tool_input: dict[str, Any],
        context: PermissionContext,
    ) -> PermissionDecision:
        return PermissionDecision(
            behavior=self._permission,
            message=f"Host tool `{self.name}` permission check.",
        )


def _append_mcp_tools(tools: list[HostExternalTool], mcp_tools: list[dict[str, Any]] | None) -> None:
    for raw in mcp_tools or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "").strip()
        description = str(raw.get("description") or "").strip()
        input_schema = raw.get("inputSchema") if isinstance(raw.get("inputSchema"), dict) else {"type": "object"}
        capability = str(raw.get("capability") or "").strip() or None
        if not name or not description:
            continue
        tools.append(
            HostExternalTool(
                name=name,
                description=description[:500],
                input_schema=input_schema,
                is_read_only=False,
                permission=PermissionBehavior.ASK if capability == "network-access" else PermissionBehavior.ALLOW,
                capability=capability,
            ),
        )


def build_host_toolkit(
    skills: list[dict[str, Any]] | None = None,
    mcp_tools: list[dict[str, Any]] | None = None,
) -> Toolkit:
    skill_objs: list[Skill] = []
    for raw in skills or []:
        name = str(raw.get("name") or raw.get("id") or "").strip()
        description = str(raw.get("description") or "").strip()
        if not name or not description:
            continue
        markdown = str(raw.get("instructions") or f"# {name}\n\n{description}\n")
        directory = str(raw.get("rootPath") or f"/virtual/skills/{raw.get('id') or name}")
        skill_objs.append(
            Skill(
                name=name,
                description=description[:500],
                dir=directory,
                markdown=markdown[:24_000],
                updated_at=0.0,
            ),
        )

    tools = [
        HostExternalTool(
            name="host_ping",
            description="Health/echo tool executed by the Workmate host. Use to verify host tool bridge.",
            input_schema={
                "type": "object",
                "properties": {"message": {"type": "string", "description": "Optional message to echo"}},
                "additionalProperties": False,
            },
            is_read_only=True,
            permission=PermissionBehavior.ALLOW,
        ),
        HostExternalTool(
            name="read_workspace_file",
            description="Read a UTF-8 text file from the current run workspace (host-executed).",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path inside the run workspace"},
                },
                "required": ["path"],
                "additionalProperties": False,
            },
            is_read_only=True,
            permission=PermissionBehavior.ALLOW,
        ),
        HostExternalTool(
            name="write_workspace_file",
            description="Write/replace a UTF-8 text file in the current run workspace (host-executed; may require approval).",
            input_schema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                    "deliverable": {"type": "boolean"},
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
            is_read_only=False,
            permission=PermissionBehavior.ASK,
        ),
    ]
    _append_mcp_tools(tools, mcp_tools)
    return Toolkit(tools=tools, skills_or_loaders=skill_objs if skill_objs else None)
