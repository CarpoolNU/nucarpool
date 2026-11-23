import { envsafe } from "envsafe";
import {
  DEPLOY_ENVS,
  deployEnvValidator,
} from "../../src/utils/env/deployEnvValidator";

/**
 * Refuses to start the Lambda without `NEXT_PUBLIC_ENV`, whatever `NODE_ENV`
 * says (SCRUM-740).
 *
 * `emailParams.ts` reads the variable through `deployEnv.ts`, whose
 * `devDefault: "development"` envsafe applies whenever `NODE_ENV` is not
 * `production`. `next build` sets `NODE_ENV`; the Lambda runtime does not. So
 * in the Lambda that default always applied, a function whose environment
 * lacked the variable started normally as "not staging", and the gmail-only
 * recipient filter was off — on a stack whose database holds
 * production-derived admin addresses.
 *
 * **Why a second validation rather than setting `NODE_ENV`.** envsafe reads
 * `NODE_ENV` from the `env` object it is handed, not from the literal
 * expression `process.env.NODE_ENV`, so an esbuild
 * `--define:process.env.NODE_ENV` only swaps which envsafe build is bundled
 * and the default still applies — checked against a real bundle, which loaded
 * with `DATABASE_URL` alone. Putting `NODE_ENV` in `template.yaml` instead
 * would hold only until someone configures the function by hand, which is the
 * exposure this closes. Validating here with no `devDefault` works under any
 * `NODE_ENV`, in Jest as well as in the bundle, and changes nothing else.
 *
 * **Same allow-list and parser as `deployEnv.ts`, minus the default.** A value
 * this accepts, `deployEnv.ts` accepts identically, so the two cannot disagree
 * about which deployment this is; they differ only on a missing value, where
 * this one throws. `handler.ts` imports this first so the refusal names the
 * cause before anything else in the graph runs.
 */
envsafe({
  NEXT_PUBLIC_ENV: deployEnvValidator({
    input: process.env.NEXT_PUBLIC_ENV,
    choices: DEPLOY_ENVS,
  }),
});
