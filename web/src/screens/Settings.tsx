import type { ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { useAppData } from "../app/context";
import { useLoad } from "../app/useLoad";
import { useTitle } from "../app/useTitle";
import { Icon } from "../design/Icon";
import { THEME_CHOICES, useTheme } from "../design/theme";
import { usable } from "../project/providers";
import { reminderState } from "../app/reminders";
import { AdvancedSettings } from "./settings/AdvancedSettings";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { BackupsSection } from "./settings/BackupsSection";
import { MakersPhoneList, MakersSettings } from "./settings/MakersSettings";
import { LibrarySection } from "./settings/LibrarySection";
import { PhoneSection } from "./settings/PhoneSection";
import { ProvidersSection } from "./settings/ProvidersSection";
import { RemindersSection } from "./settings/RemindersSection";
import { SetupSection } from "./settings/SetupSection";
import { useNarrow } from "./settings/useNarrow";
import { VideosSettings } from "./settings/VideosSettings";
import { VoiceSettings } from "./settings/VoiceSettings";
import "./settings.css";

/** Settings' sections, in order; each opens at `/settings#<id>`. Advanced sits apart at the end. */
const SECTIONS = [
  { id: "makers", label: "What makes what", view: () => <MakersSettings /> },
  { id: "setup", label: "Get set up", view: () => <SetupSection /> },
  { id: "providers", label: "Providers", view: () => <ProvidersSection /> },
  { id: "voice", label: "Voice", view: () => <VoiceSettings /> },
  { id: "videos", label: "Videos", view: () => <VideosSettings /> },
  { id: "library", label: "Library", view: () => <LibrarySection /> },
  { id: "backups", label: "Backups", view: () => <BackupsSection /> },
  { id: "phone", label: "Phone", view: () => <PhoneSection /> },
  { id: "reminders", label: "Reminders", view: () => <RemindersSection /> },
  { id: "appearance", label: "Appearance", view: () => <AppearanceSettings /> },
  { id: "advanced", label: "Advanced", view: () => <AdvancedSettings /> },
] as const satisfies ReadonlyArray<{ id: string; label: string; view: () => ReactNode }>;

type SectionId = (typeof SECTIONS)[number]["id"];

/** The section a link asks for: its hash, or Providers for an older `?provider=` link. */
function sectionOf(hash: string, params: URLSearchParams): SectionId | undefined {
  const id = hash.replace(/^#/, "");
  const found = SECTIONS.find((s) => s.id === id);
  if (found) return found.id;
  return params.has("provider") ? "providers" : undefined;
}

/**
 * One Settings page: the sections on the left and the chosen one beside
 * them. On a phone it is a list that opens each section on its own page.
 * No spend is shown anywhere (docs/DECISIONS.md #45); the engine still
 * records it.
 */
export function Settings() {
  const { hash } = useLocation();
  const [params] = useSearchParams();
  const narrow = useNarrow();
  const asked = sectionOf(hash, params);
  const current = SECTIONS.find((s) => s.id === (asked ?? "makers"))!;
  useTitle(asked && asked !== "makers" ? `${current.label} · Settings` : "Settings");

  if (narrow && (asked === undefined || asked === "makers")) return <PhoneIndex />;
  if (narrow) {
    return (
      <div className="settings sx narrow">
        <Link className="sx-back" to="/settings" aria-label="Back to Settings">
          <Icon name="chev-l" />
          Settings
        </Link>
        <div className="sx-main">{current.view()}</div>
      </div>
    );
  }
  return (
    <div className="settings sx">
      <aside className="sx-side">
        <h1>Settings</h1>
        <nav aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <Link key={s.id} to={{ hash: `#${s.id}` }} className={`${s.id === current.id ? "on" : ""}${s.id === "advanced" ? " apart" : ""}`} aria-current={s.id === current.id ? "page" : undefined}>
              {s.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="sx-main">{current.view()}</div>
    </div>
  );
}

/** Settings on a phone: What makes what as a list, then every other section with its state in a word. */
function PhoneIndex() {
  const { client, providers } = useAppData();
  const voice = useLoad(() => client.voice(), [client]);
  const phone = useLoad(() => client.phone(), [client]);
  const [theme] = useTheme();
  const ready = providers?.providers.filter(usable).length;
  const service = voice.data?.service ? voice.data.services.find((s) => s.id === voice.data?.service) : undefined;
  const words: Partial<Record<SectionId, { text: string; warn?: boolean }>> = {
    ...(ready !== undefined ? { providers: { text: `${ready} ready`, ...(ready === 0 ? { warn: true } : {}) } } : {}),
    ...(voice.data ? { voice: service ? { text: service.label } : { text: "Not set up", warn: true } } : {}),
    ...(phone.data ? { phone: { text: phone.data.on ? "Listening" : "Off" } } : {}),
    reminders: { text: { on: "On", off: "Off", blocked: "Blocked", unsupported: "Not on this browser" }[reminderState()] },
    appearance: { text: THEME_CHOICES.find((c) => c.value === theme)?.label ?? "" },
  };
  return (
    <div className="settings sxp">
      <header className="sxp-top">
        <Link className="ib" to="/" aria-label="Back">
          <Icon name="chev-l" />
        </Link>
        <h1>Settings</h1>
      </header>
      <MakersPhoneList />
      <section className="sxp-group" aria-label="More">
        <div className="sxp-gh">
          <h2>More</h2>
        </div>
        <ul className="sxp-list">
          {SECTIONS.filter((s) => s.id !== "makers").map((s) => {
            const w = words[s.id];
            return (
              <li key={s.id}>
                <Link className="sxp-row" to={{ hash: `#${s.id}` }}>
                  <span className="sxp-name">{s.label}</span>
                  {w && <span className={`sxp-word${w.warn ? " warn" : ""}`}>{w.text}</span>}
                  <Icon name="chev-r" className="ico sxp-chev" />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
