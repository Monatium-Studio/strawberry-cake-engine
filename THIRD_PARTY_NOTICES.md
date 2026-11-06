# Third-party notices

This project includes or adapts code from the projects below. Their licenses apply to the parts named.

## recast-navigation-js

- Project: https://github.com/isaac-mason/recast-navigation-js (packages `recast-navigation`, `@recast-navigation/core`, `@recast-navigation/wasm`, `@recast-navigation/generators`)
- Used as: a runtime dependency (Recast/Detour WASM bindings).
- Adapted code: `src/nav/generate.ts` ports and splits `generateTileCache` from `@recast-navigation/generators` 0.44.0
  (tile rasterization moved into a worker-safe class, tile cache assembly kept on the main thread), and applies the same
  memory-leak fix as the upstream generator. `src/nav/bake.worker.ts` runs that ported code in a Web Worker.
- License: MIT

```
The MIT License

Copyright © 2025 Isaac Mason

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Recast & Detour

- Project: https://github.com/recastnavigation/recastnavigation
- Used as: compiled into the WebAssembly module shipped by `@recast-navigation/wasm` (not vendored in this repository).
- License: zlib (Copyright (c) 2009 Mikko Mononen memon@inside.org). See the upstream repository for the full text.
