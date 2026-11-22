package com.whispernotes.review;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * 手机端外壳。
 *
 * 这里只做一件事：把 WebView 的"缩放"彻底关掉。
 * 起因（2026-11 用户反馈）：在笔记页可以把整页捏小 —— 页面缩到上半屏、下面一大块黑。
 * 原因有两层：
 *   ① 浏览器/WebView 允许 pinch-zoom out（meta 里只限了放大、没限缩小）；
 *   ② WebView 的 loadWithOverviewMode 会在内容比屏幕"宽"时自动缩小整页去适配。
 * 两层都关掉，再让网页层（index.css）用 100dvh + overflow:hidden 固定外壳，
 * 页面就不会再出现"整页缩小 / 底部露黑"的现象。
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;
        WebSettings s = webView.getSettings();
        // 手势缩放 / 缩放按钮全部关掉
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        // 不做"整页适配缩小"，布局宽度跟随设备
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        // 系统字体缩放不影响布局（避免被系统设置放大后挤压排版）
        s.setTextZoom(100);
        webView.setInitialScale(0);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
    }
}
