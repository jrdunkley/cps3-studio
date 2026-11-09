# data/ (private)

The Studio's sound data lives here once you make it from your own ROM:

```sh
node cli/studio.js rom import path/to/sfiii3nr1.zip path/to/sfiii3.zip     # writes data/pack.js
```

The Studio page does not need it (it keeps the same data in the browser after you choose your zips on its welcome
screen); the classic editor, the command line and the tests do. `pack.js` holds Capcom's driver code, tables,
music and samples: never share or commit it. Git ignores everything in this folder except this file.
