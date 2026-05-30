#!/usr/bin/env ruby
#
# Check for changed posts

Jekyll::Hooks.register :posts, :post_init do |post|

  begin
    commit_num = `git rev-list --count HEAD "#{ post.path }"`
  rescue SystemCallError
    next
  end

  if commit_num.to_i > 1
    begin
      lastmod_date = `git log -1 --pretty="%ad" --date=iso "#{ post.path }"`
    rescue SystemCallError
      next
    end
    post.data['last_modified_at'] = lastmod_date
  end

end
