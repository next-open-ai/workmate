<script setup lang="ts">
defineProps<{
  name:
    | 'chat'
    | 'employees'
    | 'capabilities'
    | 'knowledge'
    | 'automations'
    | 'assets'
    | 'projects'
    | 'settings'
    | 'remote'
    | 'env'
    | 'plus'
    | 'chevron-left'
    | 'chevron-right'
    | 'theme-system'
    | 'theme-light'
    | 'theme-dark'
    | 'theme-midnight'
    | 'theme-aurora';
}>();
</script>

<template>
  <svg class="h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name === 'chat'">
      <path d="M12 20.5c4.4 0 8-2.9 8-6.5S16.4 7.5 12 7.5 4 10.4 4 14s3.6 6.5 8 6.5Z" />
      <path d="M8.5 14h7M8.5 11h4.5" />
    </template>
    <template v-else-if="name === 'employees'">
      <path d="M16 19v-1.5a3.5 3.5 0 0 0-7 0V19" />
      <circle cx="12.5" cy="8.5" r="2.75" />
      <path d="M5 19v-1.2a2.8 2.8 0 0 1 5.2-1.4" />
      <circle cx="7" cy="9.5" r="2" />
    </template>
    <template v-else-if="name === 'capabilities'">
      <path d="M12 3 4 7v6l8 4 8-4V7l-8-4Z" />
      <path d="m4 7 8 4 8-4M12 11v10" />
    </template>
    <template v-else-if="name === 'knowledge'">
      <path d="M5 5.5h6.5A2.5 2.5 0 0 1 14 8v11.5H7.5A2.5 2.5 0 0 1 5 17V5.5Z" />
      <path d="M19 5.5h-6.5A2.5 2.5 0 0 0 10 8v11.5H16.5A2.5 2.5 0 0 0 19 17V5.5Z" />
      <path d="M8 9h3.2M8 12h3.2M13.8 9H17M13.8 12H17" />
    </template>
    <template v-else-if="name === 'automations'">
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.5V12l3 2" />
    </template>
    <template v-else-if="name === 'assets'">
      <path d="M4 7.5 12 3.5l8 4v9l-8 4-8-4v-9Z" />
      <path d="M12 12v9M4 7.5 12 12l8-4.5" />
    </template>
    <template v-else-if="name === 'projects'">
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M8 9h8M8 13h5M8 17h3" />
      <circle cx="17" cy="16.5" r="1" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="2.75" />
      <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.55 1.55M16.85 16.85l1.55 1.55M5.6 18.4l1.55-1.55M16.85 7.15l1.55-1.55" />
    </template>
    <template v-else-if="name === 'remote'">
      <path d="M12 20.5c3.2 0 5.5-3.8 5.5-8.5S15.2 3.5 12 3.5 6.5 7.3 6.5 12s2.3 8.5 5.5 8.5Z" />
      <path d="M4.5 9.5h15M4.5 14.5h15M12 3.5v17" />
    </template>
    <template v-else-if="name === 'env'">
      <path d="M4 18h16M6 14l4-4 3 3 5-6" />
      <path d="M15 7h2v2" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'chevron-left'">
      <path d="m14 6-6 6 6 6" />
    </template>
    <template v-else-if="name === 'chevron-right'">
      <path d="m10 6 6 6-6 6" />
    </template>
    <template v-else-if="name === 'theme-system'">
      <rect x="3.5" y="5" width="17" height="12" rx="2" />
      <path d="M8 17h8" />
    </template>
    <template v-else-if="name === 'theme-light'">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v1.8M12 19.2V21M3 12h1.8M19.2 12H21M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M5.6 18.4l1.3-1.3M17.1 6.9l1.3-1.3" />
    </template>
    <template v-else-if="name === 'theme-dark'">
      <path d="M20 14.5A7.5 7.5 0 0 1 9.5 4 6.5 6.5 0 1 0 20 14.5Z" />
    </template>
    <template v-else-if="name === 'theme-midnight'">
      <path d="M12 3.5a6.5 6.5 0 1 0 6.5 10.2A5.5 5.5 0 0 1 12 3.5Z" />
      <path d="M7 5.5h.01M16 8h.01M8 16h.01" />
    </template>
    <template v-else-if="name === 'theme-aurora'">
      <path d="M4 15c2.5-4 5-6 8-6s5.5 2 8 6" />
      <path d="M6 18c2-2.5 4-3.5 6-3.5s4 1 6 3.5" />
      <circle cx="17" cy="7" r="1.25" fill="currentColor" stroke="none" />
    </template>
  </svg>
</template>
