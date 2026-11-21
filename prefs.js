import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TesseraPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({title: 'Layout'});
        page.add(group);

        const add = (title, subtitle, key, upper) => {
            const row = new Adw.SpinRow({
                title, subtitle,
                adjustment: new Gtk.Adjustment({lower: 0, upper, step_increment: key === 'gap' ? 1 : 50}),
            });
            settings.bind(key, row, 'value', 0 /* Gio.SettingsBindFlags.DEFAULT */);
            group.add(row);
        };
        add('Gap', 'Space between windows and screen edges (px)', 'gap', 64);
        add('Animation duration', '0 disables animation (ms)', 'animation-duration', 1000);
        window.add(page);
    }
}
