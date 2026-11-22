import { Plugin } from "@opencode/plugin/tui"
import { registerUsageFeature } from "./tui-usage-page"

// Standalone load target for the Usage page. The main gangway TUI plugin can
// instead call `registerUsageFeature(context)` from its own setup; loading this
// plugin as the TUI entry is equivalent and keeps this feature independent of
// the live Stats page.
export default Plugin.define({
  id: "gangway.usage.tui",
  setup(context) {
    return registerUsageFeature(context)
  },
})
