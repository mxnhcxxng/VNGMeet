import { defineConfig } from "vite";
import zaloMiniApp from "zmp-vite-plugin";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default () => {
  return defineConfig({
    root: "./src",
    base: "",
    plugins: [zaloMiniApp(), react()],
    build: {
      assetsInlineLimit: 0,
      // DEBUG: để stack trace trong Zalo đọc được tên hàm thật. Revert sau khi xong.
      minify: false,
      sourcemap: true,
    },
    resolve: {
      alias: {
        "@": "/src",
      },
    },
  });
};
