<script setup lang="ts">
import { useTheme, type ThemePreference } from './theme';

const { preference, setTheme } = useTheme();
const labels: Record<ThemePreference, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
  midnight: '午夜霓虹',
  aurora: '极光玻璃',
};
</script>

<template>
  <label class="theme-selector">
    <span class="sr-only">界面主题</span>
    <select :value="preference" aria-label="界面主题" @change="setTheme(($event.target as HTMLSelectElement).value as ThemePreference)">
      <option v-for="(_, value) in labels" :key="value" :value="value">{{ labels[value] }}</option>
    </select>
  </label>
</template>
