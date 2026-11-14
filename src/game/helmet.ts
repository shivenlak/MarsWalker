// First-person helmet view: pressure-bubble rim, visor-assembly frame and neck ring drawn as layered SVG,
// plus live visor effects: gold sun visor, frost in deep cold, settled dust (wipe with X),
// breath fog in the cold, and an injury vignette.

export class Helmet {
  readonly el: HTMLDivElement;
  private frost: HTMLElement;
  private dust: HTMLElement;
  private breath: HTMLElement;
  private gold: HTMLElement;
  private hurt: HTMLElement;
  private t = 0;

  constructor(root: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "helmet";
    this.el.innerHTML = `
      <div class="hm-gold"></div>
      <svg class="hm-frost" viewBox="0 0 100 100" preserveAspectRatio="none">
        <filter id="frostf"><feTurbulence type="fractalNoise" baseFrequency="2.2" numOctaves="3" seed="4"/>
          <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 -2.4 1.25"/></filter>
        <radialGradient id="frostm" cx="50%" cy="50%" r="60%"><stop offset="45%" stop-color="#000"/><stop offset="100%" stop-color="#fff"/></radialGradient>
        <mask id="frostmask"><rect width="100" height="100" fill="url(#frostm)"/></mask>
        <rect width="100" height="100" filter="url(#frostf)" mask="url(#frostmask)" opacity="0.9"/>
      </svg>
      <svg class="hm-dust" viewBox="0 0 100 100" preserveAspectRatio="none">
        <filter id="dustf"><feTurbulence type="fractalNoise" baseFrequency="6" numOctaves="2" seed="9"/>
          <feColorMatrix values="0 0 0 0 0.62  0 0 0 0 0.42  0 0 0 0 0.28  0 0 0 -3.2 1.7"/></filter>
        <rect width="100" height="100" filter="url(#dustf)"/>
      </svg>
      <div class="hm-breath"></div>
      <div class="hm-hurt"></div>
      <svg class="hm-frame" viewBox="0 0 1600 900" preserveAspectRatio="none">
        <defs>
          <radialGradient id="rim" cx="50%" cy="47%" r="62%">
            <stop offset="78%" stop-color="#000" stop-opacity="0"/>
            <stop offset="88%" stop-color="#120c08" stop-opacity="0.75"/>
            <stop offset="100%" stop-color="#050404" stop-opacity="1"/>
          </radialGradient>
          <linearGradient id="shine" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="#fff" stop-opacity="0.10"/><stop offset="0.35" stop-color="#fff" stop-opacity="0"/>
            <stop offset="0.8" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#ffd9a0" stop-opacity="0.07"/>
          </linearGradient>
          <linearGradient id="visorband" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#d8d4cc"/><stop offset="0.7" stop-color="#9a958c"/><stop offset="1" stop-color="#3a3632"/>
          </linearGradient>
          <linearGradient id="neck" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#6c6f74"/><stop offset="0.5" stop-color="#b6b9be"/><stop offset="1" stop-color="#3b3d41"/>
          </linearGradient>
        </defs>
        <rect width="1600" height="900" fill="url(#rim)"/>
        <rect width="1600" height="900" fill="url(#shine)"/>
        <!-- visor assembly: top band with lamp housings -->
        <path d="M0,0 H1600 V70 C1300,20 300,20 0,70 Z" fill="url(#visorband)" opacity="0.95"/>
        <path d="M0,70 C300,20 1300,20 1600,70" stroke="#222" stroke-width="5" fill="none" opacity="0.7"/>
        <!-- neck ring / bubble seal at the bottom -->
        <path d="M0,900 V835 C400,795 1200,795 1600,835 V900 Z" fill="url(#neck)" opacity="0.95"/>
        <path d="M0,835 C400,795 1200,795 1600,835" stroke="#e6e8ea" stroke-width="3" fill="none" opacity="0.6"/>
        <!-- side bubble edges -->
        <path d="M0,70 C-20,300 -20,600 0,835 L40,835 C10,600 10,300 40,70 Z" fill="#0a0806" opacity="0.8"/>
        <path d="M1600,70 C1620,300 1620,600 1600,835 L1560,835 C1590,600 1590,300 1560,70 Z" fill="#0a0806" opacity="0.8"/>
        <!-- faint interior reflection of the comm cap and DCM display -->
        <ellipse cx="800" cy="120" rx="360" ry="26" fill="#fff" opacity="0.035"/>
        <rect x="690" y="860" width="220" height="10" rx="5" fill="#16c7e0" opacity="0.25"/>
      </svg>`;
    root.appendChild(this.el);
    const q = (s: string) => this.el.querySelector(s) as HTMLElement;
    this.frost = q(".hm-frost"); this.dust = q(".hm-dust"); this.breath = q(".hm-breath");
    this.gold = q(".hm-gold"); this.hurt = q(".hm-hurt");
    this.el.hidden = true;
  }

  set visible(v: boolean) { this.el.hidden = !v; }

  /** frost/dust 0..1, gold visor down, health 0..100, exertion 0..1, cold (breath shows below 0 C inside the visor's view) */
  update(dt: number, s: { frost: number; dust: number; gold: boolean; health: number; exertion: number; cold: boolean }) {
    this.t += dt * (0.25 + s.exertion * 0.35);
    this.frost.style.opacity = String(s.frost);
    this.dust.style.opacity = String(Math.min(0.85, s.dust));
    this.gold.style.opacity = s.gold ? "1" : "0";
    const ph = this.t % 1;
    const fog = s.cold ? Math.max(0, Math.sin(ph * Math.PI * 2)) * (0.25 + s.exertion * 0.3) : 0;
    this.breath.style.opacity = String(fog);
    const lo = Math.max(0, (60 - s.health) / 60);
    this.hurt.style.opacity = String(lo * (0.55 + 0.45 * Math.sin(this.t * 12)));
  }
}
