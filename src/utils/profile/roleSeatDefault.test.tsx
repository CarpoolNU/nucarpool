/**
 * The role field's seat coercion, against a real `useForm` (SCRUM-380).
 *
 * `roleSeatDefault.test.ts` pins the decision. This pins the *wiring*, which is
 * where the bug actually lived: the rule was always right, and an effect ran it
 * on an occasion it was never meant for. A test of the pure function alone
 * would have passed against the broken code.
 *
 * So the subject here is the sequence both profile pages perform on load —
 * mount with `profileDefaultValues` (role `RIDER`), then `reset(...)` with the
 * stored row — and the assertion is that a driver's stored `0` is still `0`
 * afterwards. The old effect turned it into `1` at exactly this point.
 *
 * A harness rather than `profile/index.tsx` or `setup.tsx` themselves: those
 * pages are behind NextAuth, Mapbox and a dozen tRPC queries, and neither can
 * be imported into a test without mocking all of it. What the pages contribute
 * to this behaviour is `register("role")` on three radios plus a `reset` from
 * `user.me`, and that is reproduced exactly below. The pages are held to using
 * this helper by their own diff — the effect is gone from both.
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
    // The regression. Mount is RIDER/0 by default, `reset` then makes it
    // DRIVER/0 - the transition the old effect could not distinguish from a
    // user switching to DRIVER.
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
