The library is called papyra

we are going to setup a library similar to /Users/alexwine/Documents/BuildQube/takeoff-calculator

The output is a napi-rs package (make sure to read the docs for napi-rs on some of the particulars).

We want a monorepo because we are going to do the same kind of deal we did in the takeoff-calculator where we have an app that we use to view the results of everything in a web page.

Here is the basics that I am thinking. We are going for approximate feature parity with pdfjs but at better speeds.

So my hypothesis is we use a rust pdfium wrapper (I think they are all wrappers if there is one that isn't that could be cool)

Some technical notes

- bun for the js stuff
- vite and react for the demo app
- some benchmarking to compare between our package and other js libs at least in rendering pages
- We need to ensure that if we are using pdfium wrapper that we bundle the pdfium code as well it looks like we can pre-compiled releases from https://github.com/bblanchon/pdfium-binaries/releases
  - I know I've read that there is a way to do this but I can't seem to find it on the napi-rs site
- I'm kind of thinking we do the initial pdfium setup in a different crate so if we decide that a pdfium wrapper is not the move we can pivot or pick what we want without a complete tear down of the previous code. (if that makes sense)
- This might be a long shot but whatever main function we use when it comes time to input a pdf file I would like to have it be the standard typed array deal but it would also be cool if it could be a js File (this is not required but would be nice)
