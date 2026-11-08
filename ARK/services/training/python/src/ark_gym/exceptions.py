"""Exceptions raised by ark_gym, mirroring bridge error codes."""


class ArkBridgeError(Exception):
    """Base class for all ark_gym bridge errors."""


class ArkProtocolError(ArkBridgeError):
    """Wire-protocol violation: version mismatch, bad framing, corrupt line."""


class ArkValidationError(ArkBridgeError, ValueError):
    """Invalid config, action, seed, or reset options (client or server side)."""


class ArkUnknownEnvError(ArkBridgeError, KeyError):
    """Unknown or already-closed environment id."""


class ArkEpisodeError(ArkBridgeError):
    """Episode-ordering violation: step before reset, or step after done."""


class ArkEnvLimitError(ArkBridgeError):
    """Bridge hosts the maximum number of live environments."""


class ArkEnvError(ArkBridgeError):
    """Simulation-side failure reported by the bridge (message preserved)."""


class BridgeCrashedError(ArkBridgeError):
    """The Node.js bridge process died or became unreachable."""


class BridgeTimeoutError(ArkBridgeError, TimeoutError):
    """No bridge response within the configured timeout."""
