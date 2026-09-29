import { render } from "@testing-library/react";
import { createPortal } from "react-dom";
import PageTitle from "./PageTitle";

/*
 * `next/head` needs Next's head manager to do anything, and a bare jsdom render
 * has none - the real component would leave `document.title` empty whether or
 * not `PageTitle` was correct. Stand in for it with the one behaviour that
 * matters here: its children land in `document.head`. Whether Next then applies
 * them is Next's contract, checked against a served page rather than here.
 */
jest.mock("next/head", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) =>
    createPortal(children, document.head),
}));

afterEach(() => {
  document.title = "";
});

describe("PageTitle", () => {
  it("titles the document with the page name and the product", () => {
    render(<PageTitle page="Profile" />);
    expect(document.title).toBe("Profile - CarpoolNU");
  });

  it("titles the document with the product alone when given no page", () => {
    render(<PageTitle />);
    expect(document.title).toBe("CarpoolNU");
  });
});
