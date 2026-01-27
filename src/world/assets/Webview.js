export default (world, app, fetch, props, setTimeout) => {
  app.configure([
    {
      key: 'url',
      type: 'text',
      label: 'URL'
    },
  ])
  app.keepActive = true

  var __defProp = Object.defineProperty;
  var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

  // apps/youtube/index.js
  var block = app.get("Block");
  if (block) {
    block.visible = false;
  }
  function toEmbedUrl(url) {
    try {
      const u = new URL(url);
      let videoId = null;
      if (u.hostname === "youtu.be") {
        videoId = u.pathname.slice(1).split("/")[0];
      } else if (u.hostname.includes("youtube.com")) {
        if (u.pathname.includes("/embed/")) {
          return url;
        }
        if (u.pathname === "/watch") {
          videoId = u.searchParams.get("v");
        } else if (u.pathname.startsWith("/v/")) {
          videoId = u.pathname.slice(3).split("/")[0];
        } else if (u.pathname.startsWith("/shorts/")) {
          videoId = u.pathname.slice(8).split("/")[0];
        }
      }
      if (videoId) {
        return `https://www.youtube.com/embed/${videoId}?autoplay=1`;
      }
    } catch (e) {
    }
    return url;
  }
  __name(toEmbedUrl, "toEmbedUrl");
  // var DEFAULT_URL = "https://www.youtube.com/embed/jfKfPfyJRdk?autoplay=1";
  var currentUrl = props.url;
  var webview = app.create("webview", {
    src: currentUrl,
    width: 3,
    height: 2,
    position: [0, 1.5, 0],
    factor: 200
  });
  app.add(webview);
  // var urlInput = app.create("uiinput", {
  //   value: currentUrl,
  //   placeholder: "Enter URL...",
  //   width: 280,
  //   height: 28,
  //   factor: 100,
  //   fontSize: 12,
  //   padding: 6,
  //   borderRadius: 4,
  //   backgroundColor: "#ffffff",
  //   borderColor: "#555555",
  //   position: [0, 2.7, 0],
  //   onSubmit: /* @__PURE__ */ __name((url) => {
  //     if (url) {
  //       const embedUrl = toEmbedUrl(url);
  //       currentUrl = embedUrl;
  //       webview.src = embedUrl;
  //     }
  //   }, "onSubmit")
  // });
  // app.add(urlInput);
}
