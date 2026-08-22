# ⚡ 14. Đặc Tả Chi Tiết Yêu Cầu Phi Chức Năng Đo Lường Được (Measurable NFRs)

Tài liệu này xác định các chỉ số đo lường phi chức năng định lượng chính xác:

| Tiêu chí NFR | Chỉ số Đo lường (Metric) | Giá trị Mục tiêu (Target) | Phương pháp đo lường |
| :--- | :--- | :--- | :--- |
| **High Refresh Rate** | Jank Frame Rate | $< 1.0\%$ dropped frames trên màn hình 120Hz | Flutter DevTools Performance Overlay |
| **RAM Footprint** | Peak Memory Usage | $< 150MB$ khi cuộn 100 trang ảnh 4K | Android Profiler / Xcode Instruments |
| **Cached API Latency** | P95 Response Time | $< 150ms$ | K6 Load Testing (100 VUs) |
| **DB API Latency** | P95 Response Time | $< 300ms$ | K6 Load Testing (100 VUs) |
| **Image Delivery TTFB** | Time to First Byte | $< 500ms$ qua Nginx Cache Proxy | Chrome Lighthouse / WebPageTest |
| **Availability** | Production Target SLA | $99.9\%$ Uptime | Prometheus Uptime Exporter |
| **Accessibility** | WCAG Compliance | Đạt chuẩn **WCAG 2.1 AA** | Axe DevTools Accessibility Scanner |
