// @ts-check
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

/**
 * @watch-flights/core is TypeScript written for Node ESM, so its relative
 * imports name the compiled file ("./geo.js") rather than the source
 * ("./geo.ts"). Resolve those to the source, falling back to the default.
 */
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    try {
      return context.resolveRequest(
        context,
        `${moduleName.slice(0, -3)}.ts`,
        platform
      );
    } catch {
      // Not a TypeScript source; resolve the name as written.
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
