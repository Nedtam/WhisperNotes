package com.whispernotes.review;

import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.WindowInsetsController;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

/**
 * 手机端外壳。
 *
 * 这里做两件"系统层"的事（都不改网页布局）：
 *  1. 关掉 WebView 缩放：pinch-zoom out 会把整页缩小、下面留黑（2026-11 用户反馈）；
 *     loadWithOverviewMode 也会在内容比屏幕宽时自动缩小整页，一并关掉。
 *  2. 把窗口/系统栏底色对齐网页当前背景色：WebView 没铺到的那条（导航栏/手势区）
 *     原本会露出窗口默认的白色，看起来就是底部一条白边。深浅色切换后重新同步一次。
 */
public class MainActivity extends BridgeActivity {
    private int appliedColor = Color.TRANSPARENT;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;
        WebSettings s = webView.getSettings();
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        s.setTextZoom(100);
        webView.setInitialScale(0);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);

        // 首帧之后再取页面背景色（此时 CSS 变量已生效）
        new Handler(Looper.getMainLooper()).postDelayed(() -> syncChromeColors(webView), 600);
        new Handler(Looper.getMainLooper()).postDelayed(() -> syncChromeColors(webView), 1800);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            new Handler(Looper.getMainLooper()).postDelayed(() -> syncChromeColors(webView), 300);
        }
    }

    /** 读网页 body 的背景色，刷到 WebView / 窗口 / 系统栏上 */
    private void syncChromeColors(WebView webView) {
        webView.evaluateJavascript("getComputedStyle(document.body).backgroundColor", value -> {
            int color = parseCssColor(value);
            if (color == Color.TRANSPARENT) return;
            if (color == appliedColor) return;
            appliedColor = color;
            try {
                webView.setBackgroundColor(color);
                getWindow().setBackgroundDrawable(new ColorDrawable(color));
                getWindow().setStatusBarColor(color);
                getWindow().setNavigationBarColor(color);
                // 亮色底用深色图标，暗色底用浅色图标
                boolean light = isLight(color);
                WindowInsetsController c = getWindow().getInsetsController();
                if (c != null) {
                    int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                    c.setSystemBarsAppearance(light ? mask : 0, mask);
                }
            } catch (Throwable ignored) {
                // 某些系统不允许改系统栏颜色 → 忽略，别影响使用
            }
        });
    }

    /** "rgb(23, 24, 28)" / "rgba(23, 24, 28, 1)" → 0xFF17181C */
    private static int parseCssColor(String raw) {
        if (raw == null) return Color.TRANSPARENT;
        String v = raw.trim();
        if (v.startsWith("\"") && v.endsWith("\"") && v.length() > 1) v = v.substring(1, v.length() - 1);
        if (v.startsWith("#")) {
            try {
                return Color.parseColor(v.length() == 4
                        ? "#" + v.charAt(1) + v.charAt(1) + v.charAt(2) + v.charAt(2) + v.charAt(3) + v.charAt(3)
                        : v);
            } catch (Throwable e) {
                return Color.TRANSPARENT;
            }
        }
        int a = v.indexOf('('), b = v.indexOf(')');
        if (a < 0 || b < a) return Color.TRANSPARENT;
        String[] parts = v.substring(a + 1, b).split(",");
        try {
            int r = (int) Float.parseFloat(parts[0].trim());
            int g = (int) Float.parseFloat(parts[1].trim());
            int gr = (int) Float.parseFloat(parts[2].trim());
            int al = parts.length > 3 ? Math.round(Float.parseFloat(parts[3].trim()) * 255f) : 255;
            return Color.argb(al, r, g, gr);
        } catch (Throwable e) {
            return Color.TRANSPARENT;
        }
    }

    private static boolean isLight(int color) {
        double luma = 0.2126 * Color.red(color) + 0.7152 * Color.green(color) + 0.0722 * Color.blue(color);
        return luma > 150;
    }
}
