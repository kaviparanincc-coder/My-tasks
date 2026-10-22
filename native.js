// Optional bridge for the Capacitor Android wrapper (see capacitor/README.md).
// In a normal browser / installed PWA this file does nothing.
// NOTE: the native path is UNTESTED in this delivery (no Android SDK was available to build it).
const plugin = () => {
  const cap = globalThis.Capacitor;
  return cap && cap.isNativePlatform && cap.isNativePlatform() ? cap.Plugins && cap.Plugins.LocalNotifications : null;
};

export const isNative = () => !!(globalThis.Capacitor && globalThis.Capacitor.isNativePlatform && globalThis.Capacitor.isNativePlatform());

const hash = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return Math.abs(x) % 2147483000 + 1; };

export async function requestNativePermission() {
  const ln = plugin();
  if (!ln) return null;
  try { return (await ln.requestPermissions()).display === 'granted'; } catch { return false; }
}

/** Re-schedule real OS notifications for open tasks that have a future due date + time. */
export async function syncNativeReminders(tasks, enabled) {
  const ln = plugin();
  if (!ln) return;
  try {
    const pending = await ln.getPending();
    if (pending.notifications && pending.notifications.length) await ln.cancel({ notifications: pending.notifications });
    if (!enabled) return;
    const now = Date.now();
    const notifications = tasks
      .filter((t) => !t.done && t.dueDate && t.dueTime)
      .map((t) => {
        const [y, m, d] = t.dueDate.split('-').map(Number);
        const [hh, mm] = t.dueTime.split(':').map(Number);
        return { t, at: new Date(y, m - 1, d, hh, mm) };
      })
      .filter((x) => x.at.getTime() > now)
      .sort((a, b) => a.at - b.at)
      .slice(0, 60)
      .map(({ t, at }) => ({ id: hash(t.id), title: t.title, body: 'Task due now', schedule: { at, allowWhileIdle: true } }));
    if (notifications.length) await ln.schedule({ notifications });
  } catch { /* never break the app because of notifications */ }
}
