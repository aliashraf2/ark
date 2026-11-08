"""ark_gym: Gymnasium adapter for ARK's Rapier rover simulation."""

from .client import BridgeClient
from .env import ArkEnv
from .exceptions import (
    ArkBridgeError,
    ArkEnvError,
    ArkEnvLimitError,
    ArkEpisodeError,
    ArkProtocolError,
    ArkUnknownEnvError,
    ArkValidationError,
    BridgeCrashedError,
    BridgeTimeoutError,
)

__version__ = "0.1.0"

__all__ = [
    "ArkEnv",
    "BridgeClient",
    "ArkBridgeError",
    "ArkEnvError",
    "ArkEnvLimitError",
    "ArkEpisodeError",
    "ArkProtocolError",
    "ArkUnknownEnvError",
    "ArkValidationError",
    "BridgeCrashedError",
    "BridgeTimeoutError",
]
