# Draw Studio extension tests

Node tests for pure functions exported from `draw_studio_ffi.mjs` (geometry pipeline, code emission, eraser, grid snap, etc.). These live outside `test/` so Gradescope’s gleeunit suite is unchanged.

## Run

From the project root:

```bash
gleam build && node --test ext_tests/*.test.mjs
```

`gleam build` copies `src/draw_studio_ffi.mjs` into `build/dev/javascript/animator/`, which is what the tests import.

Course autograder tests are unchanged:

```bash
gleam test -- q1 q2 q3 q4 q5 q6 q7 q8
```