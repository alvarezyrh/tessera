UUID = tessera@vzy.local
DEST = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

schemas: ; glib-compile-schemas schemas
install: schemas
	mkdir -p $(dir $(DEST)) && ln -sfn $(CURDIR) $(DEST)
pack: ; gnome-extensions pack --force --extra-source=tree.js .
