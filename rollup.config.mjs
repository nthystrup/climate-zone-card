import resolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";

const dev = process.env.ROLLUP_WATCH === "true";

export default {
  input: "src/climate-zone-card.ts",
  output: {
    file: "dist/climate-zone-card.js",
    format: "es",
    inlineDynamicImports: true,
  },
  plugins: [
    resolve(),
    typescript({ tsconfig: "./tsconfig.json", exclude: ["src/**/*.test.ts"] }),
    !dev && terser({ format: { comments: false } }),
  ],
};
