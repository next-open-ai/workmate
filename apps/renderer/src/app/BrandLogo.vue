<script setup lang="ts">
defineProps<{ size?: 'sm' | 'md' }>();
</script>

<template>
  <span
    :class="[
      'grid place-items-center overflow-hidden rounded-[10px] bg-[linear-gradient(145deg,#2f49c8_0%,#4566db_55%,#6f8cff_100%)] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18)]',
      size === 'md' ? 'h-9 w-9' : 'h-8 w-8',
    ]"
    aria-hidden="true"
  >
    <svg
      :class="size === 'md' ? 'h-5 w-5' : 'h-[18px] w-[18px]'"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 3.5 5.5 7v5.2c0 3.7 2.7 6.4 6.5 7.8 3.8-1.4 6.5-4.1 6.5-7.8V7L12 3.5Z"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linejoin="round"
        opacity="0.95"
      />
      <circle cx="12" cy="11.2" r="2.15" fill="currentColor" />
      <circle cx="8.2" cy="9.4" r="1.05" fill="currentColor" opacity="0.9" />
      <circle cx="15.8" cy="9.4" r="1.05" fill="currentColor" opacity="0.9" />
      <circle cx="12" cy="15.2" r="1.05" fill="currentColor" opacity="0.9" />
      <path
        d="M9.1 9.9 10.7 10.8M14.9 9.9 13.3 10.8M12 13.35v0.7"
        stroke="currentColor"
        stroke-width="1.35"
        stroke-linecap="round"
      />
    </svg>
  </span>
</template>
