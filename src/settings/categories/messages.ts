import type { SettingCategory } from "@/types/settings-schema";
import IconLucideMessageCircle from "~icons/lucide/message-circle";

const messagesCategory: SettingCategory = {
  id: "messages",
  icon: IconLucideMessageCircle,
  sections: [
    {
      id: "messageNotifications",
      items: [
        {
          key: "socialNotifications",
          type: "switch",
          binding: { store: "settings", path: "system.system.socialNotifications" },
          defaultValue: true,
        },
      ],
    },
  ],
};
export default messagesCategory;
