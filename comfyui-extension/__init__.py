"""godot-imagegen bridge — a ComfyUI custom node that ships ONLY a web extension.

It registers no node classes; its whole purpose is to make `web/` discoverable by
ComfyUI's frontend. ComfyUI's loader requires the directory named by
`WEB_DIRECTORY` to exist and to sit next to this module, then serves every
`**/*.js` under it from `/extensions/godot-imagegen-bridge/…`.

Written by the godot-imagegen DSH plugin. Safe to delete: the plugin keeps a
manifest of everything it installed and can remove it in one action.
"""

WEB_DIRECTORY = "./web"

# No node classes. Empty mappings keep ComfyUI's loader happy (it checks for
# NODE_CLASS_MAPPINGS before falling back to the V3 entrypoint).
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["WEB_DIRECTORY", "NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
