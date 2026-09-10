/*
 * Stands in for a statically imported image in the jsdom test project.
 *
 * Next compiles `import StartIcon from "../../../public/start.png"` into an
 * object describing the asset. Jest has no such loader, so it hands the PNG's
 * bytes to `ts-jest` and dies on the first non-ASCII byte with
 * `SyntaxError: Invalid or unexpected token`.
 *
 * That failure is at **module load**, which makes it worse than it looks: the
 * suite never runs and its tests are absent from the summary rather than
 * reported as failures - the same class of silent loss that
 * `jest.shared.config.js` documents at length for ESM-only dependencies. Any
 * component test that transitively reaches an image is affected, and
 * `UserCard` reaches two, so that is most of the card and sidebar tree.
 *
 * The shape matters. `next/image` reads `src`, `width` and `height` off a
 * static import and warns or throws when they are missing, so this is a
 * plausible `StaticImageData` rather than an empty object. CommonJS because
 * `moduleNameMapper` targets are required directly, without transformation.
 */
module.exports = {
  src: "/static-image-stub.png",
  height: 1,
  width: 1,
  blurDataURL: "/static-image-stub.png",
  blurWidth: 1,
  blurHeight: 1,
};
