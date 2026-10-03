"""Hermes plugin entrypoint. Transport is shared with the standalone Node tools."""

if __package__:
    from .agent_peers import register
else:  # Direct loading by development tools such as pytest.
    from agent_peers import register

__all__ = ["register"]
