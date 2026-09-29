/*
 * The one place the product's name is spelled in a document title.
 *
 * `/` and `/sign-in` used to disagree ("CarpoolNU" against "NU Carpool"), and
 * the repository, the README and the setup wizard's own heading all use
 * CarpoolNU, so that is the spelling here. Building every title through this
 * function is what keeps the next page from picking a third.
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
