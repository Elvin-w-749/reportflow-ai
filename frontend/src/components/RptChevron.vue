<template>
  <view
    class="rpt-chevron"
    :class="`rpt-chevron-${direction}`"
    aria-hidden="true"
  >
    <view class="rpt-chevron-stroke"></view>
  </view>
</template>

<script setup>
defineProps({
  direction: {
    type: String,
    default: 'right',
    validator: (value) => ['left', 'right', 'up', 'down'].includes(value)
  }
})
</script>

<style scoped>
.rpt-chevron {
  width: 1em;
  height: 1em;
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  line-height: 1;
}

.rpt-chevron-stroke {
  width: 44%;
  height: 44%;
  display: block;
  position: relative;
  box-sizing: border-box;
  border-top: 2px solid currentColor;
  border-right: 2px solid currentColor;
}

/*
 * A rotated top/right border occupies only one half of its square on the
 * pointing axis. Offset it by half that visual extent so the painted strokes,
 * rather than the source square, are centred in the hit-area container.
 */
.rpt-chevron-right .rpt-chevron-stroke { left: -15.5%; transform: rotate(45deg); }
.rpt-chevron-left .rpt-chevron-stroke { left: 15.5%; transform: rotate(-135deg); }
.rpt-chevron-up .rpt-chevron-stroke { top: 15.5%; transform: rotate(-45deg); }
.rpt-chevron-down .rpt-chevron-stroke { top: -15.5%; transform: rotate(135deg); }
</style>
