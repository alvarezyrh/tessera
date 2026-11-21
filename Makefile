UUID := $(shell sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' metadata.json)
EXT_DIR ?= $(HOME)/.local/share/gnome-shell/extensions
DEST := $(EXT_DIR)/$(UUID)

.PHONY: schemas install uninstall pack enable disable

schemas:
	glib-compile-schemas schemas

# Development install: symlink this checkout into the user extensions dir.
install: schemas
	mkdir -p $(EXT_DIR)
	ln -sfn $(CURDIR) $(DEST)
	@echo "Installed to $(DEST). Log out/in (Wayland) or Alt+F2 'r' (X11), then: make enable"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(DEST)

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Build an installable zip (schemas are compiled by gnome-extensions pack).
pack:
	gnome-extensions pack --force --extra-source=tree.js .
