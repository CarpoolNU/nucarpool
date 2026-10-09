/**
 * The role field's seat coercion, against a real `useForm`.
 *
 * `roleSeatDefault.test.ts` pins the decision. This pins the *wiring*: a test
 * of the pure function alone cannot see whether the form actually invokes it
 * at the right moment and not at others.
 *
 * So the subject here is the sequence both profile pages perform on load —
 * mount with `profileDefaultValues` (role `RIDER`), then `reset(...)` with the
 * stored row — and the assertion is that a driver's stored `0` is still `0`
 * afterwards, since that transition (RIDER/0 to DRIVER/0 on reset) is exactly
 * the one a population-vs-switch rule has to get right.
 *
 * A harness rather than `profile/index.tsx` or `setup.tsx` themselves: those
 * pages are behind NextAuth, Mapbox and a dozen tRPC queries, and neither can
 * be imported into a test without mocking all of it. What the pages contribute
 * to this behaviour is `register("role")` on three radios plus a `reset` from
 * `user.me`, and that is reproduced exactly below. Both pages reach this
 * behaviour only through `registerRoleWithSeatDefault`.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Role, Status } from "@prisma/client";
import { useForm } from "react-hook-form";
import { useEffect } from "react";
import { OnboardingFormInputs } from "../types";
import { profileDefaultValues } from "./zodSchema";
import { registerRoleWithSeatDefault } from "./roleSeatDefault";

/**
 * The three role radios and the seat field, wired the way both pages wire them.
 *
 * `stored` stands in for `user.me`: when it is supplied, the `reset` effect
 * mirrors the pages' own, which deliberately re-runs on every change so a save
 * refetch shows what was stored.
 */
const RoleForm = ({
  stored,
}: {
  stored?: { role: Role; seatAvail: number };
}) => {
  const { register, watch, setValue, reset } = useForm<OnboardingFormInputs>({
    defaultValues: profileDefaultValues,
  });

  useEffect(() => {
    if (stored) {
      reset({ ...profileDefaultValues, ...stored });
    }
  }, [reset, stored]);

  const roleField = registerRoleWithSeatDefault({ register, watch, setValue });

  return (
    <form>
      {[Role.VIEWER, Role.RIDER, Role.DRIVER].map((role) => (
        <label key={role} htmlFor={role}>
          {role}
          <input id={role} type="radio" value={role} {...roleField} />
        </label>
      ))}
      <output data-testid="seatAvail">{watch("seatAvail")}</output>
      <output data-testid="role">{watch("role")}</output>
    </form>
  );
};

const seats = () => screen.getByTestId("seatAvail").textContent;
const role = () => screen.getByTestId("role").textContent;

describe("registerRoleWithSeatDefault", () => {
  describe("populating the form from the stored row", () => {
    // Mount is RIDER/0 by default, and `reset` then makes it DRIVER/0 - the
    // transition that has to be told apart from a user actually switching to
    // DRIVER.
    it("leaves a full driver's stored 0 at 0", async () => {
      render(<RoleForm stored={{ role: Role.DRIVER, seatAvail: 0 }} />);

      expect(await screen.findByDisplayValue(Role.DRIVER)).toBeInTheDocument();
      expect(role()).toBe(Role.DRIVER);
      expect(seats()).toBe("0");
    });

    it("leaves a driver's stored count untouched", async () => {
      render(<RoleForm stored={{ role: Role.DRIVER, seatAvail: 3 }} />);

      expect(await screen.findByDisplayValue(Role.DRIVER)).toBeInTheDocument();
      expect(seats()).toBe("3");
    });

    it("leaves a rider at 0", async () => {
      render(<RoleForm stored={{ role: Role.RIDER, seatAvail: 0 }} />);

      expect(role()).toBe(Role.RIDER);
      expect(seats()).toBe("0");
    });
  });

  describe("a user switching role", () => {
    it("gives a rider switching to driver a usable starting count", async () => {
      const user = userEvent.setup();
      render(<RoleForm stored={{ role: Role.RIDER, seatAvail: 0 }} />);

      await user.click(screen.getByLabelText(Role.DRIVER));

      expect(role()).toBe(Role.DRIVER);
      expect(seats()).toBe("1");
    });

    it("gives a viewer switching to driver a usable starting count", async () => {
      const user = userEvent.setup();
      render(<RoleForm stored={{ role: Role.VIEWER, seatAvail: 0 }} />);

      await user.click(screen.getByLabelText(Role.DRIVER));

      expect(seats()).toBe("1");
    });

    it("zeroes a driver switching to rider", async () => {
      const user = userEvent.setup();
      render(<RoleForm stored={{ role: Role.DRIVER, seatAvail: 4 }} />);

      await user.click(screen.getByLabelText(Role.RIDER));

      expect(role()).toBe(Role.RIDER);
      expect(seats()).toBe("0");
    });

    it("zeroes a driver switching to viewer", async () => {
      const user = userEvent.setup();
      render(<RoleForm stored={{ role: Role.DRIVER, seatAvail: 4 }} />);

      await user.click(screen.getByLabelText(Role.VIEWER));

      expect(seats()).toBe("0");
    });

    it("keeps a count the driver already entered when they return to DRIVER", async () => {
      const user = userEvent.setup();
      render(<RoleForm stored={{ role: Role.DRIVER, seatAvail: 4 }} />);

      await user.click(screen.getByLabelText(Role.RIDER));
      expect(seats()).toBe("0");

      // Away and back: the 4 is gone, so this is a genuine RIDER -> DRIVER
      // switch and the starting count applies again.
      await user.click(screen.getByLabelText(Role.DRIVER));
      expect(seats()).toBe("1");
    });

    it("does not resurrect a full driver's 0 by re-selecting DRIVER", async () => {
      const user = userEvent.setup();
      render(<RoleForm stored={{ role: Role.DRIVER, seatAvail: 0 }} />);

      expect(await screen.findByDisplayValue(Role.DRIVER)).toBeInTheDocument();

      // Clicking the already-selected radio fires no change event, and even if
      // it did, `previousRole === nextRole` makes it a no-op.
      await user.click(screen.getByLabelText(Role.DRIVER));

      expect(seats()).toBe("0");
    });
  });

  it("still registers the role field itself", async () => {
    const user = userEvent.setup();
    render(<RoleForm />);

    // The wrapper delegates to `register("role")`, so the role must still be
    // written to the form store - wrapping `onChange` must not swallow it.
    await user.click(screen.getByLabelText(Role.VIEWER));

    expect(role()).toBe(Role.VIEWER);
  });
});
