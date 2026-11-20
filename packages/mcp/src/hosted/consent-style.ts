// The standalone OAuth document cannot load a SPA, scripts or remote fonts.
export const CONSENT_STYLE = `
:root {
  color-scheme: light;
  color: #171717;
  background: #f5f5f5;
  font: 1rem/1.5 system-ui, sans-serif;
}
body {
  box-sizing: border-box;
  isolation: isolate;
  position: relative;
  display: grid;
  place-items: center;
  min-height: 100vh;
  min-height: 100svh;
  margin: 0;
  padding: clamp(.75rem, 4vw, 2.5rem);
}
body:has(.backdrop) { background: var(--accent, #171717); }
.backdrop {
  position: absolute;
  inset: 0;
  z-index: -1;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 58%;
  opacity: .55;
  pointer-events: none;
}
main {
  box-sizing: border-box;
  width: min(100%, 38rem);
  min-width: 0;
  overflow-wrap: anywhere;
  padding: clamp(1.25rem, 4vw, 2.25rem);
  background: #fff;
  border: 1px solid #d4d4d4;
  border-radius: .75rem;
  box-shadow: 0 12px 32px #0002;
}
.branded { border-radius: 1.5rem; }
header { text-align: center; }
.logo {
  display: block;
  width: min(11rem, 100%);
  max-height: 5rem;
  object-fit: contain;
  margin: 0 auto .875rem;
}
h1 {
  margin: 0;
  color: #171717;
  font-size: clamp(1.5rem, 1.2rem + 1.1vw, 2rem);
  line-height: 1.2;
  text-wrap: balance;
}
.serif h1 {
  font-family: "Iowan Old Style", Palatino, "Palatino Linotype", Georgia, serif;
  font-weight: 400;
  letter-spacing: .035em;
  text-transform: uppercase;
}
p { margin: 0 0 .625rem; }
.service { margin: .5rem 0 0; color: #525252; }
.details, form { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #e5e5e5; }
.details { font-size: .9375rem; }
code { padding: .125rem .25rem; border-radius: .25rem; background: #f5f5f5; }
.warning {
  padding: .625rem .75rem;
  margin: .75rem 0;
  border-left: .2rem solid #737373;
  background: #fafafa;
}
form { display: flex; flex-wrap: wrap; justify-content: end; gap: .5rem; }
button {
  min-height: 44px;
  border: 1px solid #737373;
  border-radius: .625rem;
  padding: .625rem 1.125rem;
  background: #fff;
  color: #171717;
  font: 600 .875rem/1.25 system-ui, sans-serif;
  cursor: pointer;
}
.branded button { border-radius: 1.5rem; }
button:hover { background: #f5f5f5; }
button[value="yes"] {
  background: var(--accent, #171717);
  color: var(--button-ink, #fff);
}
button[value="yes"]:hover { text-decoration: underline; }
button:focus-visible { outline: 2px solid #171717; outline-offset: 2px; }
@media (max-width: 26rem) { button { flex: 1 0 auto; } }
`
