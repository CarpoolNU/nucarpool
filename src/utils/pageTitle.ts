/*
 * The one place the product's name is spelled in a document title.
 *
 * The repository, the README and the setup wizard's own heading all spell it
 * CarpoolNU, so that is the spelling here. Building every title through this
 * function is what keeps `/` and `/sign-in` - and every page after them -
 * from picking a different spelling.
 */
export const APP_NAME = "CarpoolNU";

/**
 * "Profile - CarpoolNU" for a named page, the bare product name for none.
 *
 * A title that is only the product name labels every tab identically, which is
 * the complaint a page title exists to answer - so a page passes its own name.
 */
export function pageTitle(page?: string): string {
  return page ? `${page} - ${APP_NAME}` : APP_NAME;
}
