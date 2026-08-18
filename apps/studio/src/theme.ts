import { BrandVariants, createLightTheme, Theme } from "@fluentui/react-components";

const scrumBlue: BrandVariants = {
  10: "#020B14",
  20: "#06182B",
  30: "#082541",
  40: "#093257",
  50: "#08406E",
  60: "#044E85",
  70: "#005D9D",
  80: "#006CB5",
  90: "#007CCE",
  100: "#168CE0",
  110: "#3A9CE8",
  120: "#5CADF0",
  130: "#7DBDF6",
  140: "#9DCEFA",
  150: "#BDDEFC",
  160: "#DCEFFF"
};

export const scrumTheme: Theme = {
  ...createLightTheme(scrumBlue),
  colorNeutralBackground1: "#F7FAFD",
  colorNeutralBackground2: "#EDF4FA",
  colorNeutralForeground1: "#0B1220",
  colorNeutralForeground2: "#465D72",
  colorNeutralStroke1: "#C9D8E5",
  borderRadiusMedium: "6px",
  borderRadiusLarge: "8px"
};
