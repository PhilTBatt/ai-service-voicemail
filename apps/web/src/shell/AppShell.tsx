// The frame of every signed-in page: the sidebar (the one navigation, from nav.ts), the top
// bar a phone gets instead, and the page itself. On a phone the sidebar is a drawer: the menu
// button opens it, and choosing a page, tapping outside it or pressing Escape closes it.
import type { MeView } from "@callmate/shared";
import { UserButton } from "@clerk/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, matchPath, useLocation } from "react-router";
import {
  Bot,
  Building,
  Inbox,
  ListChecks,
  Menu,
  Monitor,
  Moon,
  Phone,
  Settings,
  ShieldCheck,
  Sun,
  X,
  type LucideIcon,
} from "../design/icons.ts";
import { applyTheme, readTheme, type ThemeChoice } from "../design/theme.ts";
import { BrandMark } from "../ui.tsx";
import { isCurrent, navSections, type NavIcon } from "./nav.ts";

const ICONS: Record<NavIcon, LucideIcon> = {
  businesses: Building,
  admin: ShieldCheck,
  calls: Inbox,
  assistant: Bot,
  phone: Phone,
  account: Settings,
  onboarding: ListChecks,
};

export function Brand() {
  return (
    <Link to="/" className="brand">
      <BrandMark />
      AnswerMate
    </Link>
  );
}

/** `me` is null while it loads, or if it couldn't: the frame shows, with no pages to offer. */
export function AppShell({ me, children }: { me: MeView | null; children: ReactNode }) {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const openTenantId = matchPath("/tenants/:tenantId/*", pathname)?.params.tenantId ?? null;
  const sections = me ? navSections(me, openTenantId) : [];

  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  // A new page closes the drawer.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    // Into the drawer when it opens, so the keyboard and screen readers are where the eyes are.
    // The first page link (not the logo above it); on the next frame, as the drawer's open
    // styles apply.
    const frame = window.requestAnimationFrame(() => {
      const drawer = sidebar.current;
      (drawer?.querySelector<HTMLElement>(".nav-link") ?? drawer?.querySelector("a"))?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  /** Closed by Escape, the scrim or the button: back to the button that opened it. */
  const close = () => {
    setOpen(false);
    menuButton.current?.focus();
  };

  return (
    <div className="app" data-nav-open={open}>
      <a href="#main" className="skip-link">
        Skip to the page
      </a>
      <aside id="sidebar" className="sidebar" ref={sidebar}>
        <div className="sidebar-brand">
          <Brand />
        </div>
        <nav className="nav" aria-label="Main">
          {sections.map((section, index) => (
            <div key={section.heading ?? index} className="nav-section">
              {section.heading && <p className="nav-heading">{section.heading}</p>}
              {section.items.map((item) => {
                const Icon = ICONS[item.icon];
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className="nav-link"
                    aria-current={isCurrent(item, pathname) ? "page" : undefined}
                  >
                    <Icon size={18} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <ThemeSwitcher />
          {/* Always, even when /me failed: someone signed in with an address nobody invited
              must be able to sign out (and is told to). */}
          <div className="sidebar-user">
            <span className="truncate text-sm muted" title={me?.email}>
              {me?.email}
            </span>
            <UserButton />
          </div>
          <p className="sidebar-note">Times are UK time.</p>
        </div>
      </aside>
      <div className="scrim" onClick={close} />
      <div>
        <header className="topbar">
          <Brand />
          <button
            ref={menuButton}
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={open ? "Close the menu" : "Open the menu"}
            aria-controls="sidebar"
            aria-expanded={open}
            onClick={() => (open ? close() : setOpen(true))}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: LucideIcon }[] = [
  { value: "system", label: "Match this device", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/** Light, dark or the device's setting, remembered on this device (design/theme.ts). */
function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  return (
    <div className="segmented theme-switcher" role="radiogroup" aria-label="Colours">
      {THEMES.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => {
            applyTheme(value);
            setTheme(value);
          }}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
}
