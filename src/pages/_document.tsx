import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    // The app is English-only and has no localisation, so the language is a
    // literal. `next.config.js` declares no `i18n` block, which is the only
    // other thing Next derives `lang` from.
    <Html lang="en">
      <Head>
        <link
          href="https://fonts.googleapis.com/css2?family=Lato&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
